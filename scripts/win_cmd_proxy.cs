// Per-process COMSPEC shim: suppress user cmd AutoRun output during PostgreSQL's
// child version probes. Does not change registry, PATH, or the system cmd.exe.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

class CmdWithoutAutoRun
{
    static async Task ForwardInput(Process child)
    {
        try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { try { child.StandardInput.Close(); } catch (InvalidOperationException) { } }
    }

    static int Main()
    {
        string raw = Environment.CommandLine;
        int start;
        if (raw.StartsWith("\"")) start = raw.IndexOf('"', 1) + 1;
        else { start = raw.IndexOf(' '); if (start < 0) start = raw.Length; }
        var info = new ProcessStartInfo();
        info.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        info.Arguments = "/d " + raw.Substring(start).TrimStart();
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        using (var child = Process.Start(info))
        {
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            ForwardInput(child); // May wait on inherited console input; do not delay exit for it.
            child.WaitForExit();
            Task.WaitAll(output, error);
            return child.ExitCode;
        }
    }
}
