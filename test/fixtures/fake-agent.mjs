// M30: a terminal agent roost knows nothing about, for the level 0 tests. It sets its
// title, works on each line it is given for a moment (the screen moves), answers, and
// sends a notification (OSC 9). "ask" puts a y/n question on screen; "quit" exits.
import { createInterface } from "node:readline";

const out = (s) => process.stdout.write(s);
out("\x1b]2;fake agent\x07");
let asking = false;
let busy = Promise.resolve();

function work(line) {
	busy = busy.then(
		() =>
			new Promise((done) => {
				if (asking) {
					asking = false;
					out(`you said ${line}\r\nfake> `);
					return done();
				}
				if (line === "quit") process.exit(0);
				if (line === "crash") {
					// M40: dies mid-work (the screen was moving)
					out("working on crash...");
					setTimeout(() => process.exit(3), 300);
					return done();
				}
				if (line === "ask") {
					asking = true;
					out("Do you want to proceed? (y/n) ");
					return done();
				}
				out(`working on ${line}`);
				let n = 0;
				const t = setInterval(() => {
					out(".");
					if (++n < 5) return;
					clearInterval(t);
					// FAKE_QUIET: no notification at the end (an agent that just stops)
					out(`\r\nanswer: ${line}\r\n${process.env.FAKE_QUIET ? "" : `\x1b]9;finished ${line}\x07`}fake> `);
					done();
				}, 150);
			}),
	);
}

const first = process.argv[2];
if (first) work(first);
else out("fake> ");
createInterface({ input: process.stdin }).on("line", (l) => work(l.trim()));
