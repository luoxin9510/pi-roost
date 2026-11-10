import { sweepOrphans } from "../../lib/orphans.ts";

// M78: processes an earlier killed run left behind go before this one starts
export default function setup(): void {
	sweepOrphans((l) => console.log(`[roost tests] ${l}`));
}
