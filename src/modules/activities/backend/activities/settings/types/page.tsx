'use client'
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@open-mercato/ui/primitives/dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ColumnDef } from '@tanstack/react-table'
import { PlusIcon, Pencil, Trash2 } from 'lucide-react'

type TypeDefRow = {
  id: string
  typeId: string
  label: string
  icon: string
  lifecycleMode: 'fact' | 'task'
  isActive: boolean
  sortOrder: number
}

type FormState = {
  typeId: string
  label: string
  icon: string
  lifecycleMode: 'fact' | 'task'
  isActive: boolean
  sortOrder: string
}

const EMPTY_FORM: FormState = {
  typeId: 'custom:',
  label: '',
  icon: 'Activity',
  lifecycleMode: 'task',
  isActive: true,
  sortOrder: '0',
}

export default function ActivityTypesSettingsPage() {
  const t = useT()
  const qc = useQueryClient()

  const [dialogMode, setDialogMode] = React.useState<'create' | 'edit' | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})

  const { data: response, isLoading, error } = useQuery({
    queryKey: ['activity-type-definitions'],
    queryFn: async () => {
      const r = await apiCall<{ data: TypeDefRow[]; total: number }>('/api/activity-type-definitions')
      return r.result
    },
  })

  const rows: TypeDefRow[] = response?.data ?? []

  // --- Dialog helpers ---

  function openCreate() {
    setForm(EMPTY_FORM)
    setFieldErrors({})
    setEditingId(null)
    setDialogMode('create')
  }

  function openEdit(row: TypeDefRow) {
    setForm({
      typeId: row.typeId,
      label: row.label,
      icon: row.icon,
      lifecycleMode: row.lifecycleMode,
      isActive: row.isActive,
      sortOrder: String(row.sortOrder),
    })
    setFieldErrors({})
    setEditingId(row.id)
    setDialogMode('edit')
  }

  function closeDialog() {
    setDialogMode(null)
    setEditingId(null)
    setFieldErrors({})
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (fieldErrors[key]) {
      setFieldErrors((prev) => { const next = { ...prev }; delete next[key]; return next })
    }
  }

  async function handleSubmit() {
    setSaving(true)
    setFieldErrors({})
    try {
      const payload = {
        typeId: form.typeId.trim(),
        label: form.label.trim(),
        icon: form.icon.trim() || 'Activity',
        lifecycleMode: form.lifecycleMode,
        isActive: form.isActive,
        sortOrder: parseInt(form.sortOrder, 10) || 0,
      }

      let res: { ok: boolean; status: number; result: { fieldErrors?: Record<string, string[]> } | null }

      if (dialogMode === 'create') {
        res = await apiCall('/api/activity-type-definitions', { method: 'POST', body: JSON.stringify(payload) })
      } else {
        res = await apiCall(`/api/activity-type-definitions/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) })
      }

      if (!res.ok) {
        const errs = res.result?.fieldErrors ?? {}
        const flat: Record<string, string> = {}
        for (const [k, msgs] of Object.entries(errs)) {
          flat[k] = Array.isArray(msgs) ? msgs[0] ?? '' : String(msgs)
        }
        setFieldErrors(flat)
        return
      }

      await qc.invalidateQueries({ queryKey: ['activity-type-definitions'] })
      flash(
        dialogMode === 'create'
          ? t('activities.type.definitions.flash.created', 'Activity type created')
          : t('activities.type.definitions.flash.updated', 'Activity type updated'),
        'success',
      )
      closeDialog()
    } catch {
      flash(t('activities.type.definitions.flash.error', 'Failed to save activity type'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(row: TypeDefRow) {
    if (!confirm(t('activities.type.definitions.confirm.delete', `Deactivate type "${row.label}"?`))) return
    try {
      const res = await apiCall(`/api/activity-type-definitions/${row.id}`, { method: 'DELETE' })
      if (!res.ok) {
        flash(t('activities.type.definitions.flash.deleteError', 'Failed to deactivate type'), 'error')
        return
      }
      await qc.invalidateQueries({ queryKey: ['activity-type-definitions'] })
      flash(t('activities.type.definitions.flash.deleted', 'Activity type deactivated'), 'success')
    } catch {
      flash(t('activities.type.definitions.flash.deleteError', 'Failed to deactivate type'), 'error')
    }
  }

  // Keyboard shortcut: Cmd/Ctrl+Enter to submit, Escape to close
  React.useEffect(() => {
    if (!dialogMode) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeDialog(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { void handleSubmit() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogMode, form, editingId])

  const columns: ColumnDef<TypeDefRow>[] = React.useMemo(
    () => [
      {
        accessorKey: 'typeId',
        header: t('activities.type.definitions.column.typeId', 'Type ID'),
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-muted-foreground">{String(getValue() ?? '')}</span>
        ),
      },
      {
        accessorKey: 'label',
        header: t('activities.type.definitions.column.label', 'Label'),
        cell: ({ getValue }) => <span className="text-sm font-medium">{String(getValue() ?? '')}</span>,
      },
      {
        accessorKey: 'icon',
        header: t('activities.type.definitions.column.icon', 'Icon'),
        cell: ({ getValue }) => <span className="text-sm text-muted-foreground">{String(getValue() ?? '')}</span>,
      },
      {
        accessorKey: 'lifecycleMode',
        header: t('activities.type.definitions.column.lifecycle', 'Lifecycle'),
        cell: ({ getValue }) => (
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {String(getValue() ?? '')}
          </span>
        ),
      },
      {
        accessorKey: 'sortOrder',
        header: t('activities.type.definitions.column.sortOrder', 'Order'),
        cell: ({ getValue }) => <span className="text-sm">{String(getValue() ?? 0)}</span>,
      },
      {
        accessorKey: 'isActive',
        header: t('activities.type.definitions.column.active', 'Active'),
        cell: ({ getValue }) => {
          const active = getValue() === true
          return (
            <span className={active ? 'text-status-success-text text-sm' : 'text-status-error-text text-sm'}>
              {active
                ? t('activities.type.definitions.active.yes', 'Yes')
                : t('activities.type.definitions.active.no', 'No')}
            </span>
          )
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex items-center gap-1 justify-end">
            <IconButton
              aria-label={t('activities.type.definitions.action.edit', 'Edit type')}
              variant="ghost"
              size="sm"
              onClick={() => openEdit(row.original)}
            >
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton
              aria-label={t('activities.type.definitions.action.delete', 'Deactivate type')}
              variant="ghost"
              size="sm"
              onClick={() => void handleDelete(row.original)}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  )

  const toolbar = (
    <Button size="sm" onClick={openCreate}>
      <PlusIcon className="size-4 mr-1" />
      {t('activities.type.definitions.action.create', 'New type')}
    </Button>
  )

  return (
    <Page>
      <PageHeader
        title={t('activities.type.definitions.page.title', 'Activity Types')}
        actions={toolbar}
      />
      <PageBody>
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          error={error ? t('activities.type.definitions.error.load', 'Failed to load activity types') : null}
          extensionTableId="activities.type_definitions"
          emptyState={
            <EmptyState
              title={t('activities.type.definitions.empty.title', 'No custom activity types')}
              description={t(
                'activities.type.definitions.empty.description',
                'Create custom activity types to extend the default registry.',
              )}
            />
          }
        />
      </PageBody>

      <Dialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === 'create'
                ? t('activities.type.definitions.dialog.create.title', 'New Activity Type')
                : t('activities.type.definitions.dialog.edit.title', 'Edit Activity Type')}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Type ID — only editable on create */}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('activities.type.definitions.field.typeId', 'Type ID')}
                <span className="text-status-error-text ml-0.5">*</span>
              </label>
              {dialogMode === 'create' ? (
                <>
                  <input
                    type="text"
                    className="border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                    value={form.typeId}
                    placeholder="custom:my_type"
                    onChange={(e) => setField('typeId', e.target.value)}
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('activities.type.definitions.field.typeId.hint', 'Must start with "custom:" followed by lowercase letters and underscores')}
                  </p>
                </>
              ) : (
                <span className="font-mono text-sm text-muted-foreground px-3 py-1.5 border rounded bg-muted/50">
                  {form.typeId}
                </span>
              )}
              {fieldErrors.typeId && (
                <p className="text-xs text-status-error-text">{fieldErrors.typeId}</p>
              )}
            </div>

            {/* Label */}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('activities.type.definitions.field.label', 'Label')}
                <span className="text-status-error-text ml-0.5">*</span>
              </label>
              <input
                type="text"
                className="border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.label}
                placeholder={t('activities.type.definitions.field.label.placeholder', 'e.g. Demo call')}
                onChange={(e) => setField('label', e.target.value)}
              />
              {fieldErrors.label && (
                <p className="text-xs text-status-error-text">{fieldErrors.label}</p>
              )}
            </div>

            {/* Icon name */}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('activities.type.definitions.field.icon', 'Icon name (Lucide)')}
              </label>
              <input
                type="text"
                className="border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.icon}
                placeholder="Activity"
                onChange={(e) => setField('icon', e.target.value)}
              />
            </div>

            {/* Lifecycle mode */}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('activities.type.definitions.field.lifecycleMode', 'Lifecycle')}
              </label>
              <select
                className="border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.lifecycleMode}
                onChange={(e) => setField('lifecycleMode', e.target.value as 'fact' | 'task')}
              >
                <option value="task">{t('activities.type.definitions.lifecycle.task', 'Task (actionable, has status)')}</option>
                <option value="fact">{t('activities.type.definitions.lifecycle.fact', 'Fact (historical record)')}</option>
              </select>
            </div>

            {/* Sort order */}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('activities.type.definitions.field.sortOrder', 'Sort order')}
              </label>
              <input
                type="number"
                min={0}
                max={9999}
                className="border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.sortOrder}
                onChange={(e) => setField('sortOrder', e.target.value)}
              />
            </div>

            {/* Active toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setField('isActive', e.target.checked)}
                className="rounded"
              />
              <span className="text-sm">
                {t('activities.type.definitions.field.isActive', 'Active (visible in type picker)')}
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              {t('activities.type.definitions.dialog.cancel', 'Cancel')}
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={saving}>
              {saving
                ? t('activities.type.definitions.dialog.saving', 'Saving…')
                : t('activities.type.definitions.dialog.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}
