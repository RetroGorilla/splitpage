export type CommentSort = "recent" | "position";

export interface CommentSorting {
  readonly current: () => CommentSort;
  readonly choose: (value: string) => CommentSort;
}

let mode: CommentSort = "position";

export const commentSortMode = (): CommentSort => mode;
export const setCommentSort = (value: string): CommentSort => {
  mode = value === "recent" ? "recent" : "position";
  return mode;
};
