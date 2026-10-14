/**
 * The dialogue video: a chat thread, each line on its speaker's side.
 *
 * STUB — owned by the dialogue builder. Until it is written, a dialogue renders
 * like a lesson.
 */

import { prepareLesson, type PrepareOptions, type PreparedLesson } from "./renderLesson";

export async function prepareDialogue(options: PrepareOptions): Promise<PreparedLesson> {
  return prepareLesson(options);
}
