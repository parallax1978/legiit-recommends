/** Where the sign-out form posts. A route handler, so the address is the same in every build. */
export const SIGN_OUT_PATH = "/auth/sign-out";

/**
 * Signs out from a menu or a button that is not inside a form: posts to the sign-out address
 * as a normal page navigation. Browser only.
 */
export function submitSignOut(): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = SIGN_OUT_PATH;
  form.hidden = true;
  document.body.appendChild(form);
  form.submit();
}
