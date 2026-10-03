import { Check, ChevronsUpDown, LayoutGrid, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { GuildSummary } from '../../api/types';
import { useSession } from '../../hooks/useSession';
import { formatCompact } from '../../lib/format';
import { Avatar } from '../ui/Avatar';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';

export function GuildSwitcher({ current }: { current: GuildSummary }) {
  const me = useSession();
  const navigate = useNavigate();
  return (
    <Menu
      align="start"
      className="w-full"
      panelClassName="w-full"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center gap-3 rounded-xl bg-white/[0.03] p-2 text-start ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.06]"
        >
          <Avatar src={current.iconUrl} name={current.name} size={36} rounded="xl" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-100">{current.name}</p>
            <p className="text-xs text-zinc-500">{formatCompact(current.memberCount)} عضو</p>
          </div>
          <ChevronsUpDown className="size-4 shrink-0 text-zinc-500" />
        </button>
      )}
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-zinc-500">السيرفرات</p>
          <div className="max-h-72 overflow-y-auto">
            {me.guilds.map((guild) => (
              <MenuItem
                key={guild.id}
                active={guild.id === current.id}
                onClick={() => {
                  close();
                  if (guild.id !== current.id) navigate(`/g/${guild.id}`);
                }}
                icon={<Avatar src={guild.iconUrl} name={guild.name} size={24} rounded="xl" />}
              >
                <span className="min-w-0 flex-1 truncate">{guild.name}</span>
                {guild.id === current.id && <Check className="size-4 text-violet-400" />}
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<LayoutGrid className="size-4 text-zinc-400" />}
            onClick={() => {
              close();
              navigate('/guilds');
            }}
          >
            كل السيرفرات
          </MenuItem>
          <MenuItem icon={<Plus className="size-4 text-zinc-400" />} href={me.inviteUrl} external onClick={close}>
            إضافة البوت لسيرفر ثاني
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
