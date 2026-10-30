export type CommentSort = "recent" | "position";

export interface CommentSorting {
  readonly current: () => CommentSort;
  readonly choose: (value: string) => CommentSort;
}

export function createCommentSorting(): CommentSorting {
  let mode: CommentSort = "position";
  return Object.freeze({
    current: (): CommentSort => mode,
    choose: (value: string): CommentSort => {
      mode = value === "recent" ? "recent" : "position";
      return mode;
    }
  });
}
