/** Error text that is safe to print: message and code only, never URLs or passwords. */
export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const code = e?.code ? ` [${e.code}]` : "";
  let msg = e?.message ?? String(err);
  const tls =
    /certificate|self[- ]signed|unable to (get|verify)|SSL|TLS/i.test(msg) ||
    /CERT|SELF_SIGNED|UNABLE_TO/.test(e?.code ?? "");
  if (tls) {
    msg += " (TLS certificate verification failed; TLS verification is not disabled. " +
      "Check db/certs or DATABASE_CA_CERT_FILE.)";
  }
  return `${msg}${code}`;
}
