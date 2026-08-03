-- AlterTable
ALTER TABLE "node_keys" ADD COLUMN     "secretCipher" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "secretIv" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "secretTag" TEXT NOT NULL DEFAULT '';
