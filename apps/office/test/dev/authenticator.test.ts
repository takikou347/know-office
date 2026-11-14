// 開発環境のパスキーの代わり (ソフトウェアの認証器) を確かめる。ログインと記録の 3.9
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { createAuthenticator } from "../helpers/authenticator.ts";

const RP = { id: "localhost", origin: "http://localhost:5174" };

describe("開発環境の代わりの物", () => {
  it("ソフトウェアの認証器で登録し、@simplewebauthn/server が通す", async () => {
    const authenticator = await createAuthenticator();
    const options = await generateRegistrationOptions({ rpName: "know-office", rpID: RP.id, userName: "owner", authenticatorSelection: { userVerification: "required" } });
    const response = await authenticator.register(options, RP.origin);
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: options.challenge,
      expectedOrigin: RP.origin,
      expectedRPID: RP.id,
      requireUserVerification: true,
    });
    expect(result.verified).toBe(true);
    expect(result.registrationInfo?.credential.id).toBe(response.id);
  });

  it("登録したパスキーで確認し、数が 1 つ進む", async () => {
    const authenticator = await createAuthenticator();
    const registration = await generateRegistrationOptions({ rpName: "know-office", rpID: RP.id, userName: "owner", authenticatorSelection: { userVerification: "required" } });
    const created = await verifyRegistrationResponse({
      response: await authenticator.register(registration, RP.origin),
      expectedChallenge: registration.challenge,
      expectedOrigin: RP.origin,
      expectedRPID: RP.id,
    });
    const credential = created.registrationInfo?.credential;
    if (!credential) throw new Error("登録できていない");
    const options = await generateAuthenticationOptions({ rpID: RP.id, userVerification: "required" });
    const result = await verifyAuthenticationResponse({
      response: await authenticator.authenticate(options, RP.origin),
      expectedChallenge: options.challenge,
      expectedOrigin: RP.origin,
      expectedRPID: RP.id,
      credential,
      requireUserVerification: true,
    });
    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(1);
  });
});
