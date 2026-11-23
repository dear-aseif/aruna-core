/**
 * The one strings table for owner-workspace UI text (task 9.1 gate fix). Components read strings
 * only from here; the active language is a per-tenant setting (settings.ui_language, default EN).
 * Pure module: safe for server and client code.
 */
export const LANGUAGES = ["en", "id"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
}

const en = {
  "nav.board": "Board",
  "nav.chat": "Chat",
  "nav.briefings": "Briefings",
  "nav.settings": "Settings",
  "nav.catalog": "Catalog",
  "nav.bookings": "Bookings",
  "nav.stock": "Stock",
  "shell.navLabel": "Workspace",
  "shell.signOut": "Sign out",
  "shell.language": "Language",
  "shell.languageEn": "EN",
  "shell.languageId": "ID",
  "shell.languageError": "Could not change the language. Please try again.",
  "board.pipelineLabel": "Task pipeline",
  "board.filterLabel": "Filter by status",
  "board.empty": "No tasks here.",
  "board.agent": "Agent",
  "board.decideBefore": "Decide before",
  "board.approve": "Approve",
  "board.reject": "Reject",
  "board.edit": "Edit draft",
  "board.save": "Save changes",
  "board.cancel": "Cancel",
  "board.errorLabel": "Error",
  "board.quickActions": "Quick actions",
  "board.openChat": "Ask in chat",
  "board.openBriefing": "Today's briefing",
  "board.err.expired": "This approval has expired. It can no longer be approved or rejected.",
  "board.err.notAwaiting": "This task is no longer waiting for approval.",
  "board.err.revisionChanged": "The draft changed since you opened it. Refresh to see the latest.",
  "board.err.cannotApprove": "This task cannot be approved right now.",
  "board.err.generic": "Could not complete the action. Please try again.",
  "status.queued": "Queued",
  "status.working": "Working",
  "status.in_review": "In Review",
  "status.pending_approval": "Pending Approval",
  "status.done": "Done",
  "status.rejected": "Rejected",
  "status.expired": "Expired",
  "status.failed": "Failed",
  "chat.body": "Chat arrives in task 9.4.",
  "briefings.body": "Briefings arrive in task 9.4.",
  "settings.body": "Settings arrive in task 9.4.",
  "screen.notBuilt": "This screen is not built yet.",
  "notReady.title": "Workspace not ready",
  "notReady.body": "This business has no active Playbook yet. Please contact the operator.",
} as const;

export type StringKey = keyof typeof en;

const id: Record<StringKey, string> = {
  "nav.board": "Papan",
  "nav.chat": "Obrolan",
  "nav.briefings": "Ringkasan",
  "nav.settings": "Pengaturan",
  "nav.catalog": "Katalog",
  "nav.bookings": "Reservasi",
  "nav.stock": "Stok",
  "shell.navLabel": "Ruang kerja",
  "shell.signOut": "Keluar",
  "shell.language": "Bahasa",
  "shell.languageEn": "EN",
  "shell.languageId": "ID",
  "shell.languageError": "Bahasa tidak dapat diubah. Silakan coba lagi.",
  "board.pipelineLabel": "Alur tugas",
  "board.filterLabel": "Saring menurut status",
  "board.empty": "Belum ada tugas di sini.",
  "board.agent": "Agen",
  "board.decideBefore": "Putuskan sebelum",
  "board.approve": "Setujui",
  "board.reject": "Tolak",
  "board.edit": "Ubah draf",
  "board.save": "Simpan perubahan",
  "board.cancel": "Batal",
  "board.errorLabel": "Kesalahan",
  "board.quickActions": "Aksi cepat",
  "board.openChat": "Tanya di obrolan",
  "board.openBriefing": "Ringkasan hari ini",
  "board.err.expired": "Persetujuan ini sudah kedaluwarsa. Tidak dapat disetujui atau ditolak lagi.",
  "board.err.notAwaiting": "Tugas ini tidak lagi menunggu persetujuan.",
  "board.err.revisionChanged": "Draf berubah sejak Anda membukanya. Muat ulang untuk melihat yang terbaru.",
  "board.err.cannotApprove": "Tugas ini belum dapat disetujui saat ini.",
  "board.err.generic": "Aksi tidak dapat diselesaikan. Silakan coba lagi.",
  "status.queued": "Antrean",
  "status.working": "Dikerjakan",
  "status.in_review": "Ditinjau",
  "status.pending_approval": "Menunggu Persetujuan",
  "status.done": "Selesai",
  "status.rejected": "Ditolak",
  "status.expired": "Kedaluwarsa",
  "status.failed": "Gagal",
  "chat.body": "Obrolan hadir di tugas 9.4.",
  "briefings.body": "Ringkasan hadir di tugas 9.4.",
  "settings.body": "Pengaturan hadir di tugas 9.4.",
  "screen.notBuilt": "Layar ini belum dibuat.",
  "notReady.title": "Ruang kerja belum siap",
  "notReady.body": "Bisnis ini belum memiliki Playbook aktif. Silakan hubungi operator.",
};

export const STRINGS: Record<Language, Record<StringKey, string>> = { en, id };

export function translate(lang: Language, key: StringKey): string {
  return STRINGS[lang][key];
}

/** Nav entries are keyed by id ("board", or "<pack>:<screen>" for pack screens). Unknown screens fall back to the server label. */
export function navLabel(lang: Language, item: { id: string; label: string }): string {
  const key = `nav.${item.id.split(":").pop()}` as StringKey;
  return key in STRINGS[lang] ? STRINGS[lang][key] : item.label;
}
