import React, { useId, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { initialsLength, projectInitials } from '../../shared/projectAppearance';
import type { OpenProject } from '../store/atoms/openProjects';
import {
  DEFAULT_PROJECT_RAIL_GROUP_NAME,
  PROJECT_RAIL_GROUP_COLORS,
  PROJECT_RAIL_GROUP_ICONS,
  RAIL_GROUP_IMAGE_SIZE,
  type ProjectRailGroup,
  type RailGroupDisplay,
} from '../store/atoms/projectRailGroups';
import { importImageThumbnail } from '../utils/imageThumbnail';
import { ProjectRailGroupTile } from './ProjectRailGroup';

export interface RailGroupEditorValue {
  name: string;
  color: string | null;
  display: RailGroupDisplay;
  initials: string | null;
  icon: string | null;
  image: string | null;
}

/** The editor's starting values for `group`, or for a new group. */
export function railGroupEditorValue(group?: ProjectRailGroup): RailGroupEditorValue {
  return {
    name: group?.name ?? DEFAULT_PROJECT_RAIL_GROUP_NAME,
    color: group?.color ?? null,
    display: group?.display ?? 'projects',
    initials: group?.initials ?? null,
    icon: group?.icon ?? null,
    image: group?.image ?? null,
  };
}

const DISPLAY_OPTIONS: ReadonlyArray<{ value: RailGroupDisplay; label: string }> = [
  { value: 'projects', label: 'Projects' },
  { value: 'initials', label: 'Initials' },
  { value: 'icon', label: 'Icon' },
];

interface ProjectRailGroupEditorProps {
  /** The rail element the editor sits beside. */
  anchor: Element;
  title: string;
  submitLabel: string;
  initial: RailGroupEditorValue;
  /** The group's open projects, for previewing the miniature tile. */
  projects: OpenProject[];
  onSubmit: (value: RailGroupEditorValue) => void;
  onCancel: () => void;
}

/** Name, folder color and collapsed tile of a rail group. Escape or a click outside cancels. */
export function ProjectRailGroupEditor({
  anchor,
  title,
  submitLabel,
  initial,
  projects,
  onSubmit,
  onCancel,
}: ProjectRailGroupEditorProps) {
  const [draft, setDraft] = useState(initial);
  const [importing, setImporting] = useState(false);
  const [imageError, setImageError] = useState('');
  const change = (patch: Partial<RailGroupEditorValue>) => setDraft((current) => ({ ...current, ...patch }));
  const nameId = useId();
  const displayLabelId = useId();
  const initialsHelpId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onCancel(); },
    elements: { reference: anchor },
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(12),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        },
      }),
    ],
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const fallbackInitials = projectInitials(draft.name.trim() || DEFAULT_PROJECT_RAIL_GROUP_NAME);
  const invalidInitials = draft.display === 'initials' && initialsLength(draft.initials?.trim() ?? '') > 3;
  const selectedIcon = draft.icon ?? PROJECT_RAIL_GROUP_ICONS[0].icon;

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} initialFocus={nameRef}>
        <form
          ref={refs.setFloating}
          className="project-rail-group-editor"
          style={{ ...floatingStyles, ...(draft.color ? { '--rail-group-color': draft.color } : {}) } as React.CSSProperties}
          aria-label={title}
          data-testid="project-rail-group-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalidInitials || importing) return;
            // Keep only the chosen tile's values, so nothing hidden stays in the setting.
            onSubmit({
              ...draft,
              initials: draft.display === 'initials' ? draft.initials : null,
              icon: draft.display === 'icon' && !draft.image ? draft.icon : null,
              image: draft.display === 'icon' ? draft.image : null,
            });
          }}
          {...getFloatingProps()}
        >
          <div className="project-rail-group-editor-header">
            <div className="project-rail-group-editor-preview" aria-hidden="true">
              <ProjectRailGroupTile group={draft} projects={projects} />
            </div>
            <div className="project-rail-group-editor-title">{title}</div>
          </div>
          <label className="project-rail-group-editor-label" htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            ref={nameRef}
            className="project-rail-group-editor-name nim-input"
            value={draft.name}
            maxLength={60}
            spellCheck={false}
            onChange={(event) => change({ name: event.target.value })}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="project-rail-group-editor-label">Color</div>
          <div className="project-rail-group-editor-colors">
            <button
              type="button"
              className="project-rail-group-editor-swatch is-none"
              aria-label="No color"
              aria-pressed={draft.color === null}
              onClick={() => change({ color: null })}
            />
            {PROJECT_RAIL_GROUP_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="project-rail-group-editor-swatch"
                style={{ '--swatch-color': option.value } as React.CSSProperties}
                aria-label={option.name}
                aria-pressed={draft.color === option.value}
                onClick={() => change({ color: option.value })}
              />
            ))}
          </div>
          <div className="project-rail-group-editor-label" id={displayLabelId}>Collapsed tile</div>
          <div className="project-rail-group-editor-modes" role="radiogroup" aria-labelledby={displayLabelId}>
            {DISPLAY_OPTIONS.map((option) => (
              <label key={option.value} className="project-rail-group-editor-mode">
                <input
                  type="radio"
                  name={`${nameId}-display`}
                  value={option.value}
                  checked={draft.display === option.value}
                  onChange={() => change({ display: option.value })}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {draft.display === 'initials' && (
            <>
              <input
                className="project-rail-group-editor-initials nim-input"
                aria-label="Initials"
                value={draft.initials ?? ''}
                placeholder={fallbackInitials}
                maxLength={64}
                spellCheck={false}
                aria-invalid={invalidInitials}
                aria-describedby={initialsHelpId}
                onChange={(event) => change({ initials: event.target.value || null })}
              />
              <p id={initialsHelpId} className={`project-rail-group-editor-help${invalidInitials ? ' is-error' : ''}`}>
                Up to three characters or an emoji. Leave blank to use {fallbackInitials}.
              </p>
            </>
          )}
          {draft.display === 'icon' && (
            <>
              <div className="project-rail-group-editor-icons" role="group" aria-label="Icons">
                {PROJECT_RAIL_GROUP_ICONS.map((option) => (
                  <button
                    key={option.icon}
                    type="button"
                    className="project-rail-group-editor-icon"
                    aria-label={option.label}
                    aria-pressed={!draft.image && selectedIcon === option.icon}
                    onClick={() => change({ icon: option.icon, image: null })}
                  >
                    <MaterialSymbol icon={option.icon} size={18} />
                  </button>
                ))}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                aria-label="Group image"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  setImporting(true);
                  setImageError('');
                  try {
                    change({ image: await importImageThumbnail(file, RAIL_GROUP_IMAGE_SIZE) });
                  } catch (error) {
                    setImageError(error instanceof Error ? error.message : 'Could not read this image.');
                  } finally {
                    setImporting(false);
                  }
                }}
              />
              <div className="project-rail-group-editor-image">
                <button type="button" className="nim-btn-secondary" disabled={importing} onClick={() => fileRef.current?.click()}>
                  {draft.image ? 'Change image…' : 'Choose image…'}
                </button>
                {draft.image && (
                  <button type="button" className="nim-btn-secondary" onClick={() => change({ image: null })}>Remove image</button>
                )}
              </div>
              {imageError && <p className="project-rail-group-editor-help is-error" role="alert">{imageError}</p>}
            </>
          )}
          <div className="project-rail-group-editor-actions">
            <button type="button" className="nim-btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="nim-btn-primary" disabled={invalidInitials || importing}>{submitLabel}</button>
          </div>
        </form>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
