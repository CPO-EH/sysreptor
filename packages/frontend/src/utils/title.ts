import type { ArchivedProject, Breadcrumbs, FindingTemplate, PentestProject, ProjectType, UserShortInfo } from "#imports";
import type { PluginRouteScope } from "@base/utils/types";
import { sortBy } from "lodash-es";

type RouteType = ReturnType<typeof useRoute>;

export function getTitle(title?: string|null, route?: RouteType): string|null {
  return title || (route?.meta?.title as string|undefined) || null;
}

export function rootTitleTemplate(title?: string|null, route?: RouteType): string {
  const notificationStore = useNotificationStore();
  let notificationTitle = '';
  if (notificationStore.enabled && notificationStore.unreadNotificationCount > 0) {
    notificationTitle = ` (${notificationStore.unreadNotificationCount})`;
  }

  title = getTitle(title, route);
  return (title ? title + ' | ' : '') + 'SysReptor' + notificationTitle;
}

export function projectTitleTemplate(project?: PentestProject, title?: string|null, route?: RouteType) {
  title = getTitle(title, route);
  return rootTitleTemplate((title ? `${title} | ` : '') + (project?.name || ''));
}

export function designTitleTemplate(projectType?: ProjectType, title?: string|null, route?: RouteType) {
  title = getTitle(title, route);
  return rootTitleTemplate((title ? `${title} | ` : '') + (projectType?.name || ''));
}

export function profileTitleTemplate(title?: string|null, route?: RouteType) {
  title = getTitle(title, route);
  return rootTitleTemplate((title ? title + ' | ' : '') + 'Profile');
}

export function userNotesTitleTemplate(title?: string|null, route?: RouteType) {
  title = getTitle(title, route);
  return rootTitleTemplate((title ? title + ' | ' : '') + 'Notes');
}

export function projectListBreadcrumbs(): Breadcrumbs {
  return [
    { title: 'Projects', to: '/projects/' },
  ];
}

export function projectDetailBreadcrumbs(project?: PentestProject): Breadcrumbs {
  return projectListBreadcrumbs().concat([
    { title: project?.name, to: `/projects/${project?.id}/` },
  ]);
}

export function designListBreadcrumbs(): Breadcrumbs {
  return [
    { title: 'Designs', to: '/designs/' },
  ];
}

export function designDetailBreadcrumbs(projectType?: ProjectType): Breadcrumbs {
  return designListBreadcrumbs().concat([
    { title: formatProjectTypeTitle(projectType), to: `/designs/${projectType?.id}/` },
  ]);
}

export function archivedProjectListBreadcrumbs(): Breadcrumbs {
  return projectListBreadcrumbs().concat([
    { title: 'Archived', to: '/projects/archived/' },
  ]);
}

export function archivedProjectDetailBreadcrumbs(archive?: ArchivedProject): Breadcrumbs {
  return archivedProjectListBreadcrumbs().concat([
    { title: archive?.name, to: `/projects/archived/${archive?.id}/` },
  ]);
}

export function templateListBreadcrumbs(): Breadcrumbs {
  return [
    { title: 'Templates', to: '/templates/' },
  ];
}

export function templateDetailBreadcrumbs(template?: FindingTemplate|null): Breadcrumbs {
  const mainTranslation = template?.translations.find(t => t.is_main);
  return templateListBreadcrumbs().concat([
    { title: mainTranslation?.data.title || '...', to: `/templates/${template?.id}/` },
  ]);
}

export function userListBreadcrumbs(): Breadcrumbs {
  return [
    { title: 'Users', to: '/users/' },
  ];
}

export function userDetailBreadcrumbs(user?: UserShortInfo): Breadcrumbs {
  return userListBreadcrumbs().concat([
    { title: user?.username, to: `/users/${user?.id}/` },
  ]);
}

export function pluginBreadcrumbs(scope: PluginRouteScope): Breadcrumbs {
  const breadcrumbs = [
    { title: 'Plugins' },
  ] as Breadcrumbs;

  // Get nearest plugin menu entry for page
  const router = useRouter();
  const pluginStore = usePluginStore();
  const route = router.currentRoute.value;
  const routeMatches = sortBy(router.getRoutes().filter(r => route.matched.at(-1)?.path.startsWith(r.path) && r.path !== '/'), [r => -r.path.length]);
  const pluginMenuEntries = pluginStore.menuEntriesForScope(scope)
  const menuEntry = routeMatches.map(m => pluginMenuEntries.find(e => e.to.name === m.name)).filter(e => !!e)[0];
  if (menuEntry) {
    breadcrumbs.push({ title: menuEntry.title, to: menuEntry.to });
  }
  return breadcrumbs;
}
