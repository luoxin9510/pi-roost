// pi-roost's pi extension moved to adapters/pi/ (M32). Kept so a worker started before the
// move, whose saved command loads this path with -e, starts again after it.
export { default } from "../adapters/pi/index.ts";
