// Next.js freezes the flag per build; normal builds always set it to "0".
export const TEST_MODE = process.env.NEXT_PUBLIC_LAYA_TEST_MODE === "1";
// Keep the regular single-app development entrypoint unchanged.
export const LOCAL_MODE_SWITCH = false;
