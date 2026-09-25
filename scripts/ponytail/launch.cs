using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Compiled during explicit provisioning, never from a hook or a mutable checkout.
public static class PonytailLauncher {
    /// <summary>Opens files and directories for canonical path inspection without invoking a PATH utility.</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint mode, uint flags, IntPtr template);
    /// <summary>Resolves the opened handle through Windows so junctions and file links cannot hide checkout targets.</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);

    /// <summary>Normalizes Windows device prefixes while retaining an absolute drive or UNC path.</summary>
    static string Resolve(string path) {
        using (var file = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (file.IsInvalid) throw new System.ComponentModel.Win32Exception();
            var result = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(file, result, (uint)result.Capacity, 0);
            if (length == 0 || length >= result.Capacity) throw new System.ComponentModel.Win32Exception();
            string value = result.ToString();
            return value.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)
                ? @"\\" + value.Substring(8) : value.Substring(4);
        }
    }

    /// <summary>Rejects script shims before process creation; the Windows loader then validates the executable format.</summary>
    public static bool IsNativeNode(string path) {
        if (!String.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase)) return false;
        using (var file = File.OpenRead(path)) return file.ReadByte() == 0x4d && file.ReadByte() == 0x5a;
    }

    /// <summary>Includes the directory separator when comparing the outermost checkout boundary.</summary>
    static bool Inside(string path, string boundary) {
        return (path.TrimEnd('\\') + "\\").StartsWith(boundary, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Quotes for native Windows argv because .NET Framework has no ProcessStartInfo.ArgumentList.</summary>
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    /// <summary>Starts only an external native Node with sanitized environment and the installed hook, preserving its streams and exit.</summary>
    public static int Main(string[] args) {
        try {
            if (args.Length < 2 || args.Length > 3 ||
                (args[0] != "activate" && args[0] != "subagent" && args[0] != "mode-tracker") ||
                (args[1] != "codex" && args[1] != "claude" && args[1] != "copilot" && args[1] != "cursor"))
                throw new InvalidOperationException("invalid hook action or host");
            string root = null, boundary = null;
            for (var directory = new DirectoryInfo(Resolve(Directory.GetCurrentDirectory()));
                directory != null; directory = directory.Parent) {
                string marker = Path.Combine(directory.FullName, ".git");
                if (!File.Exists(marker) && !Directory.Exists(marker)) continue;
                if (root == null) root = directory.FullName;
                boundary = directory.FullName;
            }
            if (root == null) throw new InvalidOperationException("no checkout root found");
            boundary = boundary.TrimEnd('\\') + "\\";
            string node = null;
            foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
                // Rooted-but-drive-relative entries are not trusted absolute PATH entries.
                if (!(directory.StartsWith(@"\\", StringComparison.Ordinal) ||
                    (directory.Length >= 3 && Char.IsLetter(directory[0]) && directory[1] == ':' &&
                    (directory[2] == '\\' || directory[2] == '/')))) continue;
                try {
                    if (Inside(Path.GetFullPath(directory), boundary)) continue;
                    string actualDirectory = Resolve(directory);
                    if (!Directory.Exists(actualDirectory) || Inside(actualDirectory, boundary)) continue;
                    string actual = Resolve(Path.Combine(actualDirectory, "node.exe"));
                    if (Inside(actual, boundary) || !IsNativeNode(actual)) continue;
                    node = actual;
                    break;
                } catch (IOException) { }
                  catch (UnauthorizedAccessException) { }
                  catch (ArgumentException) { }
                  catch (System.ComponentModel.Win32Exception) { }
            }
            if (node == null) throw new InvalidOperationException("install Node outside the checkout on an absolute PATH");
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".agents", "hooks",
                "ponytail-" + args[0] + ".js");
            var start = new ProcessStartInfo(node, Quote(script) + " " + Quote(args[1]) + " " + Quote(root) +
                (args.Length == 3 ? " " + Quote(args[2]) : ""));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            start.EnvironmentVariables["PATH"] = Environment.SystemDirectory;
            using (var child = Process.Start(start)) {
                var input = child.StandardInput.BaseStream;
                // Hosts may keep stdin open beyond the hook's own read deadline; never wait for this pump.
                new Thread(() => {
                    try {
                        using (input) {
                            var source = Console.OpenStandardInput();
                            var buffer = new byte[8192];
                            int count;
                            while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
                                input.Write(buffer, 0, count);
                                input.Flush();
                            }
                        }
                    }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                }) { IsBackground = true }.Start();
                Task output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task errors = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                child.WaitForExit();
                Task.WaitAll(output, errors);
                return child.ExitCode;
            }
        } catch (Exception error) {
            Console.Error.WriteLine("Ponytail: " + error.Message);
            return 1;
        }
    }
}
