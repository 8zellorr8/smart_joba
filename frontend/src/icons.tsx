import type { CSSProperties } from "react";
import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

const icons = {
  calendar: CalendarBlankIcon,
  grid: SquaresFourIcon,
  lock: LockSimpleIcon,
  arrow: ArrowRightIcon,
  eye: EyeIcon,
  eyeOff: EyeSlashIcon,
  logout: SignOutIcon,
  check: CheckIcon,
  file: FileTextIcon,
  clock: ClockIcon,
  spark: SparkleIcon,
  layers: StackIcon,
  download: DownloadSimpleIcon,
  alert: WarningIcon,
  left: CaretLeftIcon,
  right: CaretRightIcon,
  close: XIcon,
  user: UserCircleIcon,
  list: ListIcon,
  edit: PencilSimpleIcon,
  book: BookOpenIcon,
  search: MagnifyingGlassIcon,
};
export function Icon({
  name,
  size = 22,
  style,
}: {
  name: keyof typeof icons;
  size?: number;
  style?: CSSProperties;
}) {
  const Symbol = icons[name];
  return (
    <Symbol
      size={size}
      weight="regular"
      aria-hidden="true"
      focusable="false"
      style={style}
    />
  );
}
