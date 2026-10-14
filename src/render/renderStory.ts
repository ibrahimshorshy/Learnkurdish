/**
 * The story video: paragraph by paragraph, the sentence being read
 * highlighted, its translation underneath.
 *
 * STUB — owned by the story builder. Until it is written, a story renders like
 * a lesson.
 */

import { prepareLesson, type PrepareOptions, type PreparedLesson } from "./renderLesson";

export async function prepareStory(options: PrepareOptions): Promise<PreparedLesson> {
  return prepareLesson(options);
}
