import { randomBytes } from "node:crypto";

export const newJobId = (): string => randomBytes(4).toString("hex");
export const newToken = (): string => randomBytes(16).toString("hex");
