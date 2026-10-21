// Where each chat's "doorbell" file lives. Shared by the bridge and the hook scripts.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const INBOX = join(HERE, ".local", "inbox");
export const doorbell = (sid) => join(INBOX, String(sid).replace(/[^A-Za-z0-9-]/g, "") + ".bell");
