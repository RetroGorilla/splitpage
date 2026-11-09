export type CommentSort = "recent" | "position" | "by-scene";

export interface CommentSorting {
  readonly current: () => CommentSort;
  readonly choose: (value: string) => CommentSort;
}

export function createCommentSorting(): CommentSorting {
  let mode: CommentSort = "position";
  return Object.freeze({
    current: (): CommentSort => mode,
    choose: (value: string): CommentSort => {
      mode = value === "recent" || value === "by-scene" ? value : "position";
      return mode;
    }
  });
}
