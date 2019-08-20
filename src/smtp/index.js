const db = require("../db");
const fs = require("fs");
const dns = require("dns");
const path = require("path");
const mailparser = require("mailparser");
const nodemailer = require("nodemailer");
const SMTPServer = require("smtp-server").SMTPServer;

function mapToObject (strMap) {

	let obj = Object.create(null);
	for (let [k,v] of strMap) {

		obj[k] = v;
		if (obj[k].text) obj[k] = obj[k].text;
		
	}
	
	return {...obj};

}

class SMTP {

	constructor (options) {

		const t = this;

		this.options = options;

		this.users = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", this.options.userfile)));
		this.banned = this.options.banfile ? JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", this.options.banfile))) : [];

		this.server = new SMTPServer({
		
			// secure: this.options.secure,
			name: this.options.host,

			// ciphers: ""

			authOptional: true,

			ca: this.options.caPath ? fs.readFileSync(path.join(__dirname, "..", "..", this.options.caPath)) : undefined,
			key: this.options.keyPath ? fs.readFileSync(path.join(__dirname, "..", "..", this.options.keyPath)) : undefined,
			cert: this.options.certPath ? fs.readFileSync(path.join(__dirname, "..", "..", this.options.certPath)) : undefined,

			banner: "MailEE SMTP Server",

			onAuth (auth, session, callback) {

				// console.log(`Authentication for user ${auth.username} requested`);

				if (!(session.secure || !this.options.tlsRequired)) {

					t.error(`Non-fatal: Client attempted to connect in violation of "tlsRequired".`);

				}

				const l = t.login(auth.username, auth.password);

				if (l) {

					callback(null, {

						user: l.username

					});

				} else {

					t.error(`Non-fatal: Invalid login information for "${auth.username}".`);
					callback(new Error("Invalid username or password; please try again."));

				}

			},

			onConnect (session, callback) {

				// console.log(`Connection from ${session.clientHostname}/${session.remoteAddress}`);

				callback(null);

			},

			onRcptTo (address, session, callback) {

				// console.log(`Email recipient ${address.address}.`)

				if (address.address.endsWith(`@${t.options.host}`)) {

					// console.log(`Translates to "${address.address.replace(`@${t.options.host}`, "")}"`);
					// console.log(`Exists: ${t.userExists(address.address.replace(`@${t.options.host}`, ""))}`);

					if (!t.userExists(address.address.replace(`@${t.options.host}`, ""))) {

						callback(new Error("Non-fatal: Recipient does not exist."));
						return;

					} else {
						
						callback(null);
						return;

					}

				}

				if (!t.isBanned(address.address)) {

					callback(null);

				} else callback(new Error("Non-fatal: Banned recipient."));

			},

			onMailFrom (address, session, callback) {

				// console.log(`Mail from ${address.address}`);

				if (!t.isBanned(address.address)) {

					callback(null);

				} else callback(new Error("Non-fatal: Banned sender."))

			},

			async onData (stream, session, callback) {

				const email = await mailparser.simpleParser(stream);

				// console.log(`New email from ${email.from.text} to ${email.to.text} with subject ${email.subject}`);

				const result = await t.inboundEmail(email, session);

				if (result === true) callback(null);
				else callback(new Error(result || "Non-fatal: Email rejected."));

			}

		});

		this.server.on("error", err => this.error(err));

	}

	listen () {

		return new Promise(resolve => {
			
			this.server.listen(this.options.port, "0.0.0.0", () => {

				console.log(`Listening on port ${this.options.port}`);
				resolve();

			});

		});

	}
	
	error (error) {

		// console.log(`MailEE has encountered an error; ${error}`);

	}

	login (username, password) {

		for (const user of this.users) {
			
			if (user.username === username && user.password) {

				if (user.password.type === "plaintext" && user.password.value === password) {

					return user;

				}

			}

		}

		return false;

	}

	userExists (username) {

		return !!this.users.find(_ => _.username === username);

	}

	isBanned (address) {

		return this.banned.indexOf(address) !== -1;

	}
	
	/**
	 * 
	 * @param {string} username Username of sender
	 * @param {string} password Password of sender
	 * @param {nodemailer.Mail.Options} data Mail data
	 */
	async sendEmail (username, password, data) {
		
		let transporter = nodemailer.createTransport({
	
			host: this.options.host,
			port: this.options.port,
			// secure: this.options.secure,
			auth: {

				user: username,
				pass: password
	
			}
	
		});

		return transporter.sendMail(data);
		
	}

	/**
	 * 
	 * @param {string} domain 
	 * 
	 * @returns {dns.MxRecord[]} 
	 */
	mx (domain) {

		return new Promise((resolve, reject) => {

			dns.resolveMx(domain, (err, addresses) => {

				if (err) reject(err);
				else resolve(addresses.sort((a, b) => a.priority - b.priority));

			});

		});

	}

	/**
	 * 
	 * @param {mailparser.ParsedMail} email 
	 * @param {SMTPServer.SMTPServerSession} session 
	 */
	async inboundEmail (email, session) {

		const t = this;

		if (!session.user) return "Non-fatal: Authentication required to send emails.";
		if (this.isBanned(email.from.value[0])) return "Non-fatal: Banned sender.";

		if (await db.getEmailFromMessageID(email.messageId)) return;

		db.addEmail(email);

		// console.log(`Sending email from ${email.from.value[0].address}`);

		if (email.from.value[0].address === `${session.user}@${this.options.host}`) {

			// console.log("Sending internal email");

			const mx = new Map();
			const to = email.to.value;
			const mail = [];

			for (const recp of to) {
				
				const user = recp.address.split("@")[0];
				const domain = recp.address.split("@")[1];

				if (!mx.has(domain)) mx.set(domain, await this.mx(domain));

				// console.log(`Sending to ${mx.get(domain)[0].exchange}.`);

				const transport = nodemailer.createTransport({

					host: mx.get(domain)[0].exchange,
					port: 25,
					name: t.options.host

				});

				// console.log(mapToObject(email.headers));

				mail.push(transport.sendMail({
					
					...mapToObject(email.headers),
					html: email.html,
					text: email.text,
					attachments: email.attachments

				}));

			}

			await Promise.all(mail);

			return true;

		} else return "Non-fatal: Invalid from.";

		return true;

	}

}

module.exports = SMTP;
