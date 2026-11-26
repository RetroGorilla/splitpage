export const LINK_PASSWORD_MAX = 256;
export const PASSWORD_SHARE_TYPE = "application/vnd.splitpage.password-share";
export const DEVICE_CREDENTIAL_HEADER = "Splitpage-Device-Credential";

export function validLinkPassword(value: unknown): value is string {
  return typeof value === "string" && value.length <= LINK_PASSWORD_MAX && value.trim().length > 0;
}
