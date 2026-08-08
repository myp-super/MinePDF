// 7za.exe 包装器：部分归档（如 winCodeSign）在无符号链接权限的 Windows
// 环境解压时返回退出码 2。若输出目录已生成有效内容，则视为成功，
// 以便 electron-builder 完成 Windows 打包（darwin 符号链接仅用于 macOS）。
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

class Program
{
    static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(typeof(Program).Assembly.Location);
        string real = Path.Combine(dir, "7za-real.exe");
        var psi = new ProcessStartInfo(real);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        string cmdline = "";
        foreach (var a in args)
        {
            cmdline += "\"" + a.Replace("\"", "\\\"") + "\" ";
        }
        psi.Arguments = cmdline;

        var p = Process.Start(psi);
        p.WaitForExit();
        if (p.ExitCode == 0) return 0;
        if (p.ExitCode != 2) return p.ExitCode;

        // 退出码 2：检查 -o 输出目录是否已生成内容
        string outDir = null;
        foreach (var a in args)
        {
            if (a.StartsWith("-o") && a.Length > 2)
            {
                outDir = a.Substring(2);
            }
        }
        if (outDir != null && Directory.Exists(outDir))
        {
            try
            {
                if (Directory.EnumerateFileSystemEntries(outDir, "*", SearchOption.AllDirectories).Any())
                {
                    return 0;
                }
            }
            catch
            {
                // 枚举失败按原错误处理
            }
        }
        return p.ExitCode;
    }
}
