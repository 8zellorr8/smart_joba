import { request, requestBlob } from "./api";

export interface Course {
  id: string;
  subject: string;
  group: string;
  academic_year: string;
  data_kind: "synthetic" | "college";
  semester: number;
  opened: boolean;
  can_manage: boolean;
}
export interface Material {
  id: string;
  title: string;
  kind: "text" | "pdf";
}
export interface Topic {
  id: string;
  title: string;
  materials: Material[];
}
export interface CourseContents {
  course: Course;
  topics: Topic[];
}

const root = (scope: string) =>
  `/api/scopes/${encodeURIComponent(scope)}/courses`;
export const materialUrl = (scope: string, course: string, material: string) =>
  `${root(scope)}/${course}/materials/${material}`;
export const courseApi = {
  list: (scope: string) => request<Course[]>(root(scope)),
  contents: (scope: string, course: string) =>
    request<CourseContents>(root(scope) + "/" + course),
  open: (scope: string, course: string, csrf: string) =>
    request(root(scope) + "/" + course + "/open", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
    }),
  addTopic: (
    scope: string,
    course: string,
    id: string,
    title: string,
    csrf: string,
  ) =>
    request(root(scope) + "/" + course + "/topics", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ id, title }),
    }),
  addMaterial: (
    scope: string,
    course: string,
    topic: string,
    form: FormData,
    csrf: string,
  ) =>
    request(root(scope) + "/" + course + "/topics/" + topic + "/materials", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: form,
    }),
  read: (scope: string, course: string, id: string) =>
    request<{ title: string; text: string }>(materialUrl(scope, course, id)),
  download: (scope: string, course: string, id: string) =>
    requestBlob(materialUrl(scope, course, id)),
};
