// Personal Workspace tasks always match. Organization tasks match only when the
// organization id is listed in ALLOWED_ORGANIZATION_IDS (comma separated).
export function allowedOrganizationIds(env = process.env) {
  return new Set(String(env.ALLOWED_ORGANIZATION_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean));
}

export function inAllowedWorkspace(task, allowed = allowedOrganizationIds()) {
  return task.organizationId === null || allowed.has(task.organizationId);
}
