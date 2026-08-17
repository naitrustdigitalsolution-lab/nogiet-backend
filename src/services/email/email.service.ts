import { Resend } from "resend";
import { env } from "../../config/env";
import { passwordResetTemplate } from "../../templates/email/password-reset";
import { welcomeTemplate } from "../../templates/email/welcome";
import { passwordChangedTemplate } from "../../templates/email/password-changed";
import { alertEmailTemplate } from "../../templates/email/alert";

export class EmailService {
  private resend: Resend | null = null;

  constructor() {
    if (env.RESEND_API_KEY) {
      this.resend = new Resend(env.RESEND_API_KEY);
    }
  }

  private async send(to: string, subject: string, html: string) {
    if (env.NODE_ENV === "test" || !this.resend) {
      console.log(`[EMAIL] To: ${to}, Subject: ${subject}`);
      return;
    }

    try {
      const { error } = await this.resend.emails.send({
        from: env.EMAIL_FROM,
        to,
        subject,
        html,
      });

      if (error) {
        console.error("Resend send error:", error);
      }
    } catch (err) {
      console.error("Email send error:", err);
    }
  }

  async sendPasswordReset(email: string, name: string, code: string) {
    const html = passwordResetTemplate(name, code);
    return this.send(email, "NOGIET - Password Reset Code", html);
  }

  async sendPasswordChanged(email: string, name: string) {
    const html = passwordChangedTemplate(name);
    return this.send(email, "NOGIET - Password Changed Successfully", html);
  }

  async sendWelcome(email: string, name: string, tempPassword: string) {
    const html = welcomeTemplate(name, email, tempPassword);
    return this.send(email, "Welcome to NOGIET Portal", html);
  }

  async sendAlert(email: string, name: string, alertTitle: string, alertDetails: string, severity = "high") {
    const html = alertEmailTemplate(name, alertTitle, alertDetails, severity);
    return this.send(email, `NOGIET Alert: ${alertTitle}`, html);
  }

  async sendDataFeedReminder(email: string, name: string, provider: string, expiresAt: Date) {
    const label = provider.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const expired = expiresAt.getTime() <= Date.now();
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>Hello ${name},</p><p>The <strong>${label}</strong> manual data feed ${expired ? "expired" : "will expire"} on <strong>${expiresAt.toLocaleDateString("en-NG")}</strong>.</p><p>Please sign in to NOGIET and upload the latest data file.</p></div>`;
    return this.send(email, `NOGIET Data Feed ${expired ? "Expired" : "Reminder"}: ${label}`, html);
  }
}
