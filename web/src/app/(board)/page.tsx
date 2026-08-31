import { Board } from "@/components/board/Board";
import { createBoard, getBoard, listBoards } from "@/data/boards";
import { listTasks } from "@/data/tasks";

export const dynamic = "force-dynamic";

/**
 * The board is the app's front door — opening AgentFlow lands you on your work,
 * not on the canvas (docs/BOARD.md).
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string }>;
}) {
  const { board: requestedBoardId } = await searchParams;

  // `?board=<id>` opens a specific board; otherwise the first one. On a first
  // run there is none yet, so seed it — never a dead-end empty state.
  const boards = await listBoards();
  const targetId = requestedBoardId ?? boards[0]?.id;
  const board = targetId ? await getBoard(targetId) : await createBoard("My work");
  if (!board) throw new Error("Could not load a board");

  const tasks = await listTasks(board.id);

  return <Board board={board} tasks={tasks} />;
}
