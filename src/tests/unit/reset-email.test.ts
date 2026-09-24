import { afterEach, describe, expect, it, vi } from "vitest";
const { config, send } = vi.hoisted(() => ({ config: { NODE_ENV: "production", RESEND_API_KEY: "test-key", EMAIL_FROM: "test@example.com" }, send: vi.fn() }));
vi.mock("../../config/env", () => ({ env: config }));
vi.mock("resend", () => ({ Resend: class { emails = { send }; } }));
import { EmailService } from "../../services/email/email.service";

describe("required reset email delivery", () => {
  afterEach(() => { config.RESEND_API_KEY = "test-key"; vi.restoreAllMocks(); send.mockReset(); });
  it("rejects a missing mail configuration", async () => {
    config.RESEND_API_KEY = "";
    await expect(new EmailService().sendPasswordReset("user@example.com", "User", "123456")).rejects.toMatchObject({ statusCode: 503 });
  });
  it.each(["rejected", "unreachable"])("rejects %s delivery instead of reporting success", async (failure) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (failure === "rejected") send.mockResolvedValue({ error: { message: "Sender not verified" } });
    else send.mockRejectedValue(new Error("Network unavailable"));
    await expect(new EmailService().sendPasswordReset("user@example.com", "User", "123456")).rejects.toMatchObject({ statusCode: 503 });
  });
  it("accepts confirmed provider delivery", async () => {
    send.mockResolvedValue({ data: { id: "message-1" }, error: null });
    await expect(new EmailService().sendPasswordReset("user@example.com", "User", "123456")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.com", from: "test@example.com" }));
  });
});
