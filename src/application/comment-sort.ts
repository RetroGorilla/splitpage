export type CommentSort = "recent" | "position";

let mode: CommentSort = "position";

export const commentSortMode = (): CommentSort => mode;
export const setCommentSort = (value: string): CommentSort => {
  mode = value === "recent" ? "recent" : "position";
  return mode;
};
