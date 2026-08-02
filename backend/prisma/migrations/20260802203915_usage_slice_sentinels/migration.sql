/*
  Warnings:

  - Made the column `providerId` on table `usage_daily` required. This step will fail if there are existing NULL values in that column.
  - Made the column `model` on table `usage_daily` required. This step will fail if there are existing NULL values in that column.
  - Made the column `workerId` on table `usage_daily` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "usage_daily" ALTER COLUMN "providerId" SET NOT NULL,
ALTER COLUMN "providerId" SET DEFAULT '',
ALTER COLUMN "model" SET NOT NULL,
ALTER COLUMN "model" SET DEFAULT '',
ALTER COLUMN "workerId" SET NOT NULL,
ALTER COLUMN "workerId" SET DEFAULT '';
