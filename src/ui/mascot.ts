import cheering from "../assets/mascot/cheering.png";
import confused from "../assets/mascot/confused.png";
import happy from "../assets/mascot/happy.png";
import neutral from "../assets/mascot/neutral.png";
import sleepy from "../assets/mascot/sleepy.png";
import thinking from "../assets/mascot/thinking.png";

/** The six approved mascot poses (A02 to A07), all at one scale so they swap in place. */
export const MASCOT = { neutral, happy, thinking, sleepy, confused, cheering } as const;
export type MascotPose = keyof typeof MASCOT;
