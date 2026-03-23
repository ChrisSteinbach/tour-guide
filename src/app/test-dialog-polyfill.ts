// jsdom doesn't implement HTMLDialogElement methods — polyfill minimally.
/* eslint-disable @typescript-eslint/unbound-method */
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
/* eslint-enable @typescript-eslint/unbound-method */
