# Native approval investigation

Date: 2026-10-29. Status: documentation investigation; no production authentication changes.

## Result

Keep existing master-password verification. A desktop helper returning an authentication boolean is insufficient for U-Chan's compromised-user-account threat model. A possible future design needs action-bound cryptographic evidence verified by the privileged service and enrollment controlled by a real protected approval.

This is a design inference from the APIs below, not an established security result for this application. No biometric key was enrolled and no hardware proof of concept was run on this host.

## Windows Hello

Microsoft documents requesting user verification and using a Windows Hello credential to sign a challenge. Keys are scoped to a user/device/application, and hardware protection depends on available configuration. Desktop interop, service/session boundaries, key ownership, and enrollment must be tested rather than assumed. Sources: [Windows Hello](https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello), [verification API](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier.requestverificationasync).

A candidate protocol would enroll a public key into protected service state, issue a fresh random nonce containing the exact action and expiry, and verify a signature using the pinned key. The service would consume the pending challenge once. A returned boolean or the helper's claim that the user approved would never suffice.

Open questions: trusted desktop key enrollment, binding the visible prompt to signed action bytes, credential replacement, compromised-app behavior, fallback PIN policy, and genuine cross-session behavior.

## Touch ID and Secure Enclave

Apple describes Secure Enclave keys whose operations return results without exposing private key material. Supported key usage and device availability impose constraints. Keychain access-control flags can restrict use; `biometryCurrentSet` invalidates the protected item when enrollment changes. Sources: [Secure Enclave keys](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave), [current biometric enrollment](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset).

A candidate would use protected enrollment and an enclave-backed signing key with explicit access controls. The privileged service would verify a one-use, action-bound signature. Merely accepting a desktop `LAContext` callback would not provide equivalent service-verifiable evidence.

Open questions: daemon/keychain identity, code-signing and entitlement constraints, secure enrollment without paid signing, key replacement, biometric fallback, and root/interactive-session behavior. These need a real macOS device.

## Vault unlock is a separate problem

Neither biometric verification nor a signature supplies Bitwarden's master password or unlock session. Replacing unlock would require a separately designed protected key-storage mechanism. This investigation does not authorize storing that password, weakening hardcore mode, or changing the vault boundary.

## Evidence required before a production proposal

- Prove enrollment cannot be replaced from the compromised user account.
- Reject reused, expired, modified, cross-action, and cross-user signatures.
- Bind displayed scope to the exact signed bytes and pending service request.
- Test cancellation, timeout, enrollment changes, absent hardware, and allowed fallbacks.
- Preserve existing password verification until a separate production design is reviewed and approved.
