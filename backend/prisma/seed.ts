import { PrismaClient } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  SystemRole,
  SystemRoleKey,
} from '../src/auth/permissions';

/**
 * Seeds the permission catalogue and the four system roles.
 *
 * Idempotent: safe to re-run after adding a permission, and safe to run
 * against an existing database during deploys.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('Seeding permissions…');
  for (const key of ALL_PERMISSIONS) {
    const [resource, action] = key.split(':');
    await prisma.permission.upsert({
      where: { key },
      update: { resource, action },
      create: { key, resource, action, description: `${action} ${resource}` },
    });
  }
  console.log(`  ${ALL_PERMISSIONS.length} permissions`);

  console.log('Seeding system roles…');
  for (const roleKey of Object.values(SystemRole) as SystemRoleKey[]) {
    // Postgres treats NULLs as distinct in unique indexes, so the
    // (key, organizationId) constraint does not dedupe system roles for us.
    // Look the row up explicitly rather than relying on upsert.
    const existing = await prisma.role.findFirst({
      where: { key: roleKey, organizationId: null },
    });

    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: roleKey, description: ROLE_DESCRIPTIONS[roleKey], isSystem: true },
        })
      : await prisma.role.create({
          data: {
            key: roleKey,
            name: roleKey,
            description: ROLE_DESCRIPTIONS[roleKey],
            isSystem: true,
          },
        });

    const permissionKeys = ROLE_PERMISSIONS[roleKey];
    const permissions = await prisma.permission.findMany({
      where: { key: { in: [...permissionKeys] } },
    });

    // Replace rather than merge, so removing a permission from a bundle
    // actually revokes it on the next seed.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });

    console.log(`  ${roleKey}: ${permissions.length} permissions`);
  }

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
