// @substrat-run/ui/wa — the primitives drawn by Web Awesome and `<sub-entity-table>`, with
// the props of the ones in the root export. Its own subpath, because the root export is
// imported by apps that register no Web Awesome. An app using these imports
// `@substrat-run/ui/wa/register` once and `@substrat-run/ui/wa.css` once.
export { Button, Checkbox, IconButton, Input, Select, SelectBox, Tabs, UNSET_BUTTON, css } from './controls';
export type { ButtonProps, CheckboxProps, IconButtonProps, InputProps, SelectProps, TabsProps } from './controls';
export { Badge, Breadcrumbs, Card, Tag, Toast } from './display';
export type { BadgeProps, CardProps, TagProps, ToastProps } from './display';
export { Dialog } from './Dialog';
export type { DialogProps } from './Dialog';
export { Table } from './Table';
export type { TableColumn, TableProps } from './Table';
