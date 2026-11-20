import { createTransport } from 'nodemailer';

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Deterministic: the receiving side drops a repeated Message-ID, so a retry after a crash shows one mail. */
  readonly messageId: string;
  readonly attachments?: readonly { readonly filename: string; readonly content: Buffer; readonly contentType: string }[];
}

export const createMailer = (cfg: { readonly host: string; readonly port: number; readonly from: string }) => {
  const transport = createTransport({ host: cfg.host, port: cfg.port, secure: false, ignoreTLS: true, pool: true, maxConnections: 4, connectionTimeout: 5_000, socketTimeout: 15_000 });
  return Object.freeze({
    send: async (mail: OutgoingMail): Promise<void> => {
      await transport.sendMail({ from: cfg.from, to: mail.to, subject: mail.subject, text: mail.text, messageId: mail.messageId, attachments: mail.attachments ? [...mail.attachments] : undefined });
    },
    close: () => transport.close(),
  });
};

export type Mailer = ReturnType<typeof createMailer>;
