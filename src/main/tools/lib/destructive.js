'use strict';

// Auto mode runs commands without asking unless they match here. Patterns are
// deliberately broad: a false positive only costs one prompt, a false negative
// can cost data. They match anywhere in the string so chained, piped or
// sudo-prefixed commands are caught too.

const LINUX = [
  // Deleting, wiping or overwriting files
  /\b(rm|rmdir|unlink|shred|truncate|wipefs)\b/,
  /\bmv\b/,
  /\bfind\b[^\n]*\s-(delete|exec\s+rm)\b/,
  /\b(sed|perl)\b[^\n]*\s-[a-z]*i/,
  /\btee\b(?![^\n|;&]*\s-a\b)/,
  /\bln\b[^\n]*\s-[a-z]*f/,
  // Disks and filesystems
  /\b(dd|mkfs(\.\w+)?|mkswap|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted|wipefs|cryptsetup|losetup)\b/,
  /\b(mount|umount|swapoff)\b/,
  // Privilege, ownership, accounts
  /\b(sudo|doas|pkexec|su)\b/,
  /\b(chmod|chown|chgrp|chattr|setfacl)\b/,
  /\b(useradd|userdel|usermod|groupdel|passwd|chpasswd|visudo)\b/,
  /\bcrontab\b[^\n]*\s-r\b/,
  // Removing software
  /\b(pacman|yay|paru)\b[^\n]*\s-R/,
  /\b(apt|apt-get|dnf|yum|zypper|snap|flatpak)\s+(remove|purge|autoremove|erase|uninstall)\b/,
  /\b(pip3?|pipx|npm|pnpm|yarn|cargo|gem)\s+(uninstall|remove|rm)\b/,
  // Services, processes, power
  /\bsystemctl\b[^\n]*\b(stop|disable|mask|kill|isolate|poweroff|reboot|halt|suspend|hibernate)\b/,
  /\b(kill|pkill|killall|xkill)\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\b(iptables|ip6tables|nft|ufw)\b/,
  // Git history and working-tree loss
  /\bgit\s+(reset\s+--hard|clean\b|checkout\s+--|restore\b|rebase\b|filter-branch|stash\s+(drop|clear)|branch\s+-[a-z]*D|push\b[^\n]*(--force|\s-f\b))/,
  // Containers
  /\b(docker|podman)\s+(rm|rmi|kill|stop|prune|system\s+prune|volume\s+(rm|prune)|image\s+(rm|prune))\b/,
  // Remote code piped into a shell, eval, fork bombs
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|fi|da)?sh\b/,
  /\beval\b/,
  /:\(\)\s*\{/
];

const WINDOWS = [
  /\b(Remove-Item|rm|rmdir|rd|del|erase|Clear-Content|Clear-RecycleBin|Move-Item|mv|move|ren|Rename-Item)\b/i,
  /\b(Set-Content|Out-File)\b/i,
  /\b(format|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|bcdedit|cipher\s+\/w)\b/i,
  /\breg\s+(add|delete|import)\b/i,
  /\b(Remove-ItemProperty|Set-ItemProperty|New-ItemProperty)\b/i,
  /\b(Stop-Process|taskkill|Stop-Service|Set-Service|sc\s+(stop|delete|config))\b/i,
  /\b(Restart-Computer|Stop-Computer|shutdown)\b/i,
  /\b(Set-ExecutionPolicy|Start-Process\b[^\n]*-Verb\s+RunAs|runas)\b/i,
  /\b(winget|choco|scoop)\s+(uninstall|remove)\b/i,
  /\b(Uninstall-Package|Uninstall-Module|Remove-AppxPackage)\b/i,
  /\b(net\s+user|Remove-LocalUser|icacls|takeown)\b/i,
  /\b(Invoke-Expression|iex)\b/i,
  /\bgit\s+(reset\s+--hard|clean\b|checkout\s+--|restore\b|rebase\b|push\b[^\n]*(--force|\s-f\b))/i
];

// `>` / `>|` / `&>` truncate their target; `>>`, `2>&1` and `> /dev/null` don't.
const OVERWRITE_REDIRECT = /(?<![>&\d])\d?(&?>|>\|)(?![>&])\s*(?!\/dev\/null\b|\$null\b|NUL\b)\S/;

/** True if running `command` could delete, overwrite or otherwise lose data or system state. */
function isDestructive(command, os = 'linux') {
  const cmd = String(command || '');
  if (!cmd.trim()) return true;
  if (OVERWRITE_REDIRECT.test(cmd)) return true;
  return (os === 'linux' ? LINUX : WINDOWS).some((re) => re.test(cmd));
}

module.exports = { isDestructive };
