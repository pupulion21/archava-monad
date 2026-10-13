/** Let wallet portals outside a native dialog receive focus and clicks. */
export function yieldDialogToWallet(dialog: HTMLDialogElement | null): () => void {
  if (!dialog?.isConnected || !dialog.open || !dialog.matches(":modal")) return () => {};
  dialog.close();
  dialog.show();
  return () => {
    if (!dialog.isConnected || !dialog.open || dialog.matches(":modal")) return;
    dialog.close();
    dialog.showModal();
  };
}
