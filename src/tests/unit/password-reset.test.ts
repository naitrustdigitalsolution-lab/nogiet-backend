import { beforeEach, describe, expect, it, vi } from "vitest";
import { comparePassword } from "../../utils/hash";

vi.mock("../../config/env", () => ({ env: { JWT_EXPIRES_IN: "15m" } }));
import { AuthService } from "../../services/auth.service";

describe("password reset service", () => {
  const user = { id: "user-1", email: "reset@example.com", fullName: "Test User", phone: null };
  const repo = {
    findByEmail: vi.fn(), createPasswordReset: vi.fn(), findValidPasswordReset: vi.fn(),
    update: vi.fn(), markPasswordResetUsed: vi.fn(), deleteAllRefreshTokens: vi.fn(),
  };
  const email = { sendPasswordReset: vi.fn(), sendPasswordChanged: vi.fn() };
  const service = new AuthService(repo as any, email as any, {} as any, {} as any);
  beforeEach(() => { vi.resetAllMocks(); });

  it("creates an expiring six-digit code and sends it by email", async () => {
    repo.findByEmail.mockResolvedValue(user);
    const before = Date.now();
    await service.forgotPassword({ email: user.email });
    const [id, code, expiry] = repo.createPasswordReset.mock.calls[0];
    expect(id).toBe(user.id);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + 3600000);
    expect(email.sendPasswordReset).toHaveBeenCalledWith(user.email, user.fullName, code);
  });

  it("does not send mail for unknown accounts", async () => {
    repo.findByEmail.mockResolvedValue(null);
    expect(await service.forgotPassword({ email: "unknown@example.com" })).toEqual({ message: "If an account exists, a reset code has been sent" });
    expect(email.sendPasswordReset).not.toHaveBeenCalled();
  });

  it("propagates reset-email delivery failures", async () => {
    repo.findByEmail.mockResolvedValue(user);
    email.sendPasswordReset.mockRejectedValue(Object.assign(new Error("Delivery unavailable"), { statusCode: 503 }));
    await expect(service.forgotPassword({ email: user.email })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects invalid, expired or previously used codes without changing passwords", async () => {
    repo.findValidPasswordReset.mockResolvedValue(null);
    await expect(service.verifyCode({ email: user.email, code: "123456" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.resetPassword({ email: user.email, code: "123456", password: "NewPassword1", confirmPassword: "NewPassword1" })).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("hashes the new password, consumes the code and revokes refresh tokens", async () => {
    repo.findValidPasswordReset.mockResolvedValue({ user, reset: { id: "reset-1" } });
    await expect(service.verifyCode({ email: user.email, code: "123456" })).resolves.toMatchObject({ valid: true });
    await service.resetPassword({ email: user.email, code: "123456", password: "NewPassword1", confirmPassword: "NewPassword1" });
    expect(await comparePassword("NewPassword1", repo.update.mock.calls[0][1].passwordHash)).toBe(true);
    expect(repo.markPasswordResetUsed).toHaveBeenCalledWith("reset-1");
    expect(repo.deleteAllRefreshTokens).toHaveBeenCalledWith(user.id);
    expect(email.sendPasswordChanged).toHaveBeenCalledWith(user.email, user.fullName);
  });
});
