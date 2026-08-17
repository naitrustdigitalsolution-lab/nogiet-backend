import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../../config/env";
import { v4 as uuid } from "uuid";

export class CloudflareR2Service {
  private client: S3Client | null = null;
  private bucket: string;
  private publicUrl: string;

  constructor() {
    this.bucket = env.R2_BUCKET_NAME;
    this.publicUrl = env.R2_PUBLIC_URL ?? "";

    if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
        forcePathStyle: true,
      });
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    contentType = "application/octet-stream"
  ): Promise<{ key: string; url: string }> {
    const key = `${folder}/${uuid()}`;

    if (!this.client) {
      console.log(`[R2] Mock upload: ${key}`);
      return { key, url: `https://mock-r2.local/${this.bucket}/${key}` };
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );

    const url = this.publicUrl
      ? `${this.publicUrl}/${key}`
      : `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${this.bucket}/${key}`;

    return { key, url };
  }

  async delete(key: string): Promise<void> {
    if (!this.client) {
      console.log(`[R2] Mock delete: ${key}`);
      return;
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  async getSignedUrl(key: string): Promise<string> {
    if (this.publicUrl) {
      return `${this.publicUrl}/${key}`;
    }
    return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${this.bucket}/${key}`;
  }

  async downloadBuffer(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!this.client) throw new Error("File archive is not configured");
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error("Archived file is empty");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    return { bytes, contentType: result.ContentType ?? "application/octet-stream" };
  }
}
