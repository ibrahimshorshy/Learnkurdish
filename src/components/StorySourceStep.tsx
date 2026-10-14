/**
 * Step 1 of a story project: paste or upload the text, then record yourself
 * reading it (or upload the recording). The text is kept as the script, so
 * the transcriber aligns it to your reading instead of guessing the words.
 *
 * STUB — owned by the story builder. For now it is the plain record step.
 */

import RecordStep, { type RecordStepProps } from "./RecordStep";

export type StorySourceStepProps = RecordStepProps;

export default function StorySourceStep(props: StorySourceStepProps) {
  return <RecordStep {...props} />;
}
