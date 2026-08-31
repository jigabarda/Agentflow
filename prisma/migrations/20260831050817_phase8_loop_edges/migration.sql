-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PipelineEdge" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sourceHandle" TEXT,
    "loop" BOOLEAN NOT NULL DEFAULT false,
    "maxIterations" INTEGER,

    PRIMARY KEY ("pipelineId", "id"),
    CONSTRAINT "PipelineEdge_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PipelineEdge" ("id", "pipelineId", "source", "sourceHandle", "target") SELECT "id", "pipelineId", "source", "sourceHandle", "target" FROM "PipelineEdge";
DROP TABLE "PipelineEdge";
ALTER TABLE "new_PipelineEdge" RENAME TO "PipelineEdge";
CREATE INDEX "PipelineEdge_pipelineId_idx" ON "PipelineEdge"("pipelineId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
