# ShellX Motion shared trusted Windows worker launcher.
# The child starts suspended, enters a bounded Job Object, and only then resumes so descendants
# cannot race outside kill-on-close containment. This file accepts only a Motion-authored JSON
# request from the already-admitted scratch directory.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = "Stop"
$requestFullPath = [IO.Path]::GetFullPath($RequestPath)
$requestDirectory = [IO.Path]::GetDirectoryName($requestFullPath)
$statusPath = $null

function Write-ContainmentStatus {
  param([hashtable]$Payload)
  if ([string]::IsNullOrWhiteSpace($script:statusPath)) { return }
  $json = $Payload | ConvertTo-Json -Compress -Depth 5
  $temporaryPath = "$($script:statusPath).tmp.$PID"
  [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporaryPath -Destination $script:statusPath -Force
}

try {
  if (-not (Test-Path -LiteralPath $requestFullPath -PathType Leaf)) {
    throw "request_missing"
  }
  $request = Get-Content -LiteralPath $requestFullPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.schema -ne "shellx-motion/windows-job-request@1") {
    throw "request_schema_invalid"
  }

  $statusPath = [IO.Path]::GetFullPath([string]$request.statusPath)
  $statusDirectory = [IO.Path]::GetDirectoryName($statusPath)
  if (-not $statusDirectory.Equals($requestDirectory, [StringComparison]::OrdinalIgnoreCase)) {
    throw "status_path_outside_request_directory"
  }
  if (-not [IO.Path]::GetFileName($statusPath).StartsWith("windows-job-", [StringComparison]::Ordinal)) {
    throw "status_file_name_invalid"
  }

  $executable = [IO.Path]::GetFullPath([string]$request.executable)
  $workingDirectory = [IO.Path]::GetFullPath([string]$request.workingDirectory)
  $arguments = [string[]]@($request.arguments)
  $maxJobMemoryBytes = [uint64]$request.maxJobMemoryBytes
  $maxActiveProcesses = [uint32]$request.maxActiveProcesses

  if (-not [IO.Path]::IsPathRooted($executable) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "executable_invalid"
  }
  if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
    throw "working_directory_invalid"
  }
  if ($arguments.Count -gt 8192 -or (($arguments | ForEach-Object { $_.Length } | Measure-Object -Sum).Sum -gt 24000)) {
    throw "argument_budget_exceeded"
  }
  if ($maxJobMemoryBytes -lt 67108864 -or $maxJobMemoryBytes -gt 1099511627776) {
    throw "memory_limit_invalid"
  }
  if ($maxActiveProcesses -lt 1 -or $maxActiveProcesses -gt 4096) {
    throw "process_limit_invalid"
  }

  # Delete the request before child execution so command metadata does not outlive launcher setup.
  Remove-Item -LiteralPath $requestFullPath -Force

  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace ShellXMotion {
  public static class WindowsJobLauncher {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public uint cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
      string lpApplicationName,
      StringBuilder lpCommandLine,
      IntPtr lpProcessAttributes,
      IntPtr lpThreadAttributes,
      bool bInheritHandles,
      uint dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFO lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    public static int Run(string executable, string[] arguments, string workingDirectory, ulong maxJobMemoryBytes, uint maxActiveProcesses, string statusPath) {
      if (String.IsNullOrWhiteSpace(executable) || !Path.IsPathRooted(executable)) throw new ArgumentException("executable");
      if (arguments == null || arguments.Length > 8192) throw new ArgumentException("arguments");
      if (maxJobMemoryBytes < 67108864UL || maxJobMemoryBytes > 1099511627776UL) throw new ArgumentOutOfRangeException("maxJobMemoryBytes");
      if (maxActiveProcesses < 1 || maxActiveProcesses > 4096) throw new ArgumentOutOfRangeException("maxActiveProcesses");

      IntPtr job = IntPtr.Zero;
      PROCESS_INFORMATION process = new PROCESS_INFORMATION();
      bool childCreated = false;
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "create_job_failed");

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
          | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
          | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
          | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = maxActiveProcesses;
        limits.JobMemoryLimit = new UIntPtr(maxJobMemoryBytes);
        int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr limitsPointer = Marshal.AllocHGlobal(limitsSize);
        try {
          Marshal.StructureToPtr(limits, limitsPointer, false);
          if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsPointer, (uint)limitsSize)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "set_job_limits_failed");
          }
        } finally {
          Marshal.FreeHGlobal(limitsPointer);
        }

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
        if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, workingDirectory, ref startup, out process)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "create_process_failed");
        }
        childCreated = true;

        if (!AssignProcessToJobObject(job, process.hProcess)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "assign_process_failed");
        }

        WriteStatus(statusPath, process.dwProcessId, maxJobMemoryBytes, maxActiveProcesses);
        if (ResumeThread(process.hThread) == UInt32.MaxValue) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "resume_process_failed");
        }
        if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "wait_process_failed");
        }
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "read_exit_code_failed");
        }
        return unchecked((int)exitCode);
      } catch {
        if (childCreated && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 126);
        throw;
      } finally {
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        // KILL_ON_JOB_CLOSE terminates any descendants still alive when the launcher exits or is killed.
        if (job != IntPtr.Zero) CloseHandle(job);
      }
    }

    private static string BuildCommandLine(string executable, string[] arguments) {
      StringBuilder result = new StringBuilder(QuoteArgument(executable));
      foreach (string argument in arguments) {
        result.Append(' ');
        result.Append(QuoteArgument(argument ?? String.Empty));
      }
      return result.ToString();
    }

    // Inverse of CommandLineToArgvW quoting: backslashes are doubled only before quotes and at the
    // closing quote, preserving empty arguments and paths ending in a backslash.
    private static string QuoteArgument(string value) {
      if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
      StringBuilder quoted = new StringBuilder("\"");
      int backslashes = 0;
      foreach (char character in value) {
        if (character == '\\') {
          backslashes += 1;
          continue;
        }
        if (character == '"') {
          quoted.Append('\\', backslashes * 2 + 1);
          quoted.Append('"');
          backslashes = 0;
          continue;
        }
        quoted.Append('\\', backslashes);
        backslashes = 0;
        quoted.Append(character);
      }
      quoted.Append('\\', backslashes * 2);
      quoted.Append('"');
      return quoted.ToString();
    }

    private static void WriteStatus(string statusPath, uint childPid, ulong maxJobMemoryBytes, uint maxActiveProcesses) {
      string json = "{\"schema\":\"shellx-motion/windows-job-status@1\",\"status\":\"enforced\",\"mode\":\"windows-job-object\",\"childPid\":"
        + childPid.ToString(System.Globalization.CultureInfo.InvariantCulture)
        + ",\"maxJobMemoryBytes\":" + maxJobMemoryBytes.ToString(System.Globalization.CultureInfo.InvariantCulture)
        + ",\"maxActiveProcesses\":" + maxActiveProcesses.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}";
      string temporaryPath = statusPath + ".tmp." + childPid.ToString(System.Globalization.CultureInfo.InvariantCulture);
      File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
      if (File.Exists(statusPath)) File.Delete(statusPath);
      File.Move(temporaryPath, statusPath);
    }
  }
}
'@

  $exitCode = [ShellXMotion.WindowsJobLauncher]::Run(
    $executable,
    $arguments,
    $workingDirectory,
    $maxJobMemoryBytes,
    $maxActiveProcesses,
    $statusPath
  )
  exit $exitCode
} catch {
  try {
    if (Test-Path -LiteralPath $requestFullPath -PathType Leaf) {
      Remove-Item -LiteralPath $requestFullPath -Force
    }
    Write-ContainmentStatus @{
      schema = "shellx-motion/windows-job-status@1"
      status = "unavailable"
      mode = "windows-job-object"
      reasonCode = "native_setup_failed"
      hresult = ("0x{0:X8}" -f ($_.Exception.HResult -band 0xffffffffL))
    }
  } catch {
    # The launcher still exits closed when even its bounded diagnostic cannot be written.
  }
  [Console]::Error.WriteLine("ShellX Motion native Windows Job Object setup failed.")
  exit 126
}
