/**
 * Which renderer draws which kind of project, and the one call the video step
 * makes: prepare the kind's video, then put the title and closing cards round
 * it.
 *
 * Video projects are not here: they are not drawn on a canvas but subtitled
 * over the uploaded video, by their own step.
 */

import type { ProjectKind } from "../types";
import { prepareLesson, type PrepareOptions, type PreparedLesson } from "./renderLesson";
import { prepareDialogue } from "./renderDialogue";
import { prepareStory } from "./renderStory";
import { wrapWithCards, type CardsInput } from "./cards";

const RENDERERS: Record<Exclude<ProjectKind, "video">, (options: PrepareOptions) => Promise<PreparedLesson>> = {
  lesson: prepareLesson,
  dialogue: prepareDialogue,
  story: prepareStory,
};

export async function prepareOutput(
  kind: ProjectKind,
  options: PrepareOptions,
  cards: CardsInput
): Promise<PreparedLesson> {
  const prepare = RENDERERS[kind as Exclude<ProjectKind, "video">] ?? prepareLesson;
  return wrapWithCards(await prepare(options), cards);
}
