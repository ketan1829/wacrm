'use client';

import { useState, useMemo } from 'react';
import { CustomField } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Plus, Search, User, Database } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface PersonalizeItem {
  type: 'field' | 'custom_field';
  value: string;
  label: string;
  category: 'contact' | 'custom';
}

interface PersonalizeMenuProps {
  customFields: CustomField[];
  onSelect: (item: { type: 'field' | 'custom_field'; value: string; label: string }) => void;
  triggerLabel?: string;
  className?: string;
  disabled?: boolean;
}

export function PersonalizeMenu({
  customFields,
  onSelect,
  triggerLabel,
  className,
  disabled = false,
}: PersonalizeMenuProps) {
  const t = useTranslations('Broadcasts.wizard.personalize');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const contactOptions: PersonalizeItem[] = useMemo(
    () => [
      { type: 'field', value: 'name', label: t('fieldMap.name') || 'Name', category: 'contact' },
      { type: 'field', value: 'phone', label: t('fieldMap.phone') || 'Phone', category: 'contact' },
      { type: 'field', value: 'email', label: t('fieldMap.email') || 'Email', category: 'contact' },
      { type: 'field', value: 'company', label: 'Company', category: 'contact' },
    ],
    [t],
  );

  const customOptions: PersonalizeItem[] = useMemo(
    () =>
      customFields.map((f) => ({
        type: 'custom_field',
        value: f.id,
        label: f.field_name,
        category: 'custom',
      })),
    [customFields],
  );

  const filteredContact = useMemo(() => {
    if (!search.trim()) return contactOptions;
    const q = search.toLowerCase();
    return contactOptions.filter((opt) => opt.label.toLowerCase().includes(q));
  }, [contactOptions, search]);

  const filteredCustom = useMemo(() => {
    if (!search.trim()) return customOptions;
    const q = search.toLowerCase();
    return customOptions.filter((opt) => opt.label.toLowerCase().includes(q));
  }, [customOptions, search]);

  function handlePick(item: PersonalizeItem) {
    onSelect({
      type: item.type,
      value: item.value,
      label: item.label,
    });
    setOpen(false);
    setSearch('');
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className={`h-8 gap-1.5 border-dashed border-border bg-muted/50 text-xs font-medium text-foreground hover:bg-muted ${className ?? ''}`}
          />
        }
      >
        <Plus className="h-3.5 w-3.5 text-primary" />
        {triggerLabel ?? t('personalizeBtn', { default: 'Personalize' })}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2 border-border bg-popover text-popover-foreground shadow-lg"
      >
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchFields', { default: 'Search fields...' })}
            className="h-8 pl-8 text-xs border-border bg-muted placeholder:text-muted-foreground"
            autoFocus
          />
        </div>

        <div className="max-h-60 overflow-y-auto space-y-3">
          {/* Contact Fields */}
          {filteredContact.length > 0 && (
            <div>
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('contactCategory', { default: 'Contact Fields' })}
              </p>
              <div className="space-y-0.5">
                {filteredContact.map((item) => (
                  <button
                    key={`contact-${item.value}`}
                    type="button"
                    onClick={() => handlePick(item)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <User className="h-3.5 w-3.5 text-primary" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom Fields */}
          {filteredCustom.length > 0 && (
            <div>
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('customCategory', { default: 'Custom Fields' })}
              </p>
              <div className="space-y-0.5">
                {filteredCustom.map((item) => (
                  <button
                    key={`custom-${item.value}`}
                    type="button"
                    onClick={() => handlePick(item)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Database className="h-3.5 w-3.5 text-blue-400" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {filteredContact.length === 0 && filteredCustom.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t('noFieldsMatch', { default: 'No matching fields found' })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
