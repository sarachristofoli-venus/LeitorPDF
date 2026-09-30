// Leitor PDF — ponte para o OCR do Windows (Windows.Media.Ocr): o reconhecedor de texto com IA que já vem
// no Windows 10 e 11, local e sem internet. Compilado por scripts/build-winocr.cjs com o compilador C# do
// .NET Framework 4 (presente em todo Windows), sem dependências.
//
// Processo auxiliar de longa duração; termina quando a entrada é fechada. Protocolo (little-endian):
//   entrada: int32 id, int32 largura, int32 altura, int32 bytes do idioma, idioma (UTF-8, ex. "pt-BR"),
//            largura × altura bytes em tons de cinza (Gray8)
//   saída:   uma linha JSON por pedido, na ordem em que terminam (os pedidos são lidos em paralelo):
//            {"id":1,"ms":123,"angle":-2.5,"lines":[[["texto",x,y,largura,altura],...],...]}
//            ou {"id":1,"error":"..."}
//            As posições estão na imagem já endireitada: gire-as "angle" graus em torno do centro da imagem.
//   ao iniciar: {"ready":true,"max":10000,"langs":["pt-BR","en-US"]}
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Security.Cryptography;

static class WinOcr
{
    static readonly object outLock = new object();
    static Stream stdout;
    // motores prontos por idioma (criar um motor carrega o modelo de reconhecimento)
    static readonly ConcurrentDictionary<string, ConcurrentBag<OcrEngine>> engines =
        new ConcurrentDictionary<string, ConcurrentBag<OcrEngine>>();

    static int Main(string[] args)
    {
        stdout = Console.OpenStandardOutput();
        var langs = new List<string>();
        foreach (var l in OcrEngine.AvailableRecognizerLanguages) langs.Add(Str(l.LanguageTag));
        Emit("{\"ready\":true,\"max\":" + OcrEngine.MaxImageDimension + ",\"langs\":[" + string.Join(",", langs) + "]}");
        var input = new BinaryReader(Console.OpenStandardInput());
        var running = new List<Task>();
        while (true)
        {
            int id, w, h;
            string lang;
            byte[] px;
            try
            {
                id = input.ReadInt32();
                w = input.ReadInt32();
                h = input.ReadInt32();
                lang = Encoding.UTF8.GetString(ReadExact(input, input.ReadInt32()));
                px = ReadExact(input, checked(w * h));
            }
            catch (EndOfStreamException) { break; }
            running.Add(Task.Run(() => Handle(id, w, h, lang, px)));
            running.RemoveAll(t => t.IsCompleted);
        }
        Task.WaitAll(running.ToArray());
        return 0;
    }

    static byte[] ReadExact(BinaryReader r, int n)
    {
        var buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int k = r.Read(buf, off, n - off);
            if (k <= 0) throw new EndOfStreamException();
            off += k;
        }
        return buf;
    }

    static OcrEngine Take(string lang)
    {
        var bag = engines.GetOrAdd(lang, _ => new ConcurrentBag<OcrEngine>());
        OcrEngine e;
        if (bag.TryTake(out e)) return e;
        e = OcrEngine.TryCreateFromLanguage(new Language(lang));
        if (e == null) throw new Exception("Idioma sem OCR no Windows: " + lang);
        return e;
    }

    static void Handle(int id, int w, int h, string lang, byte[] px)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var engine = Take(lang);
            OcrResult res;
            using (var bmp = SoftwareBitmap.CreateCopyFromBuffer(CryptographicBuffer.CreateFromByteArray(px), BitmapPixelFormat.Gray8, w, h))
            {
                px = null;
                res = Wait(engine.RecognizeAsync(bmp));
            }
            engines[lang].Add(engine);
            var sb = new StringBuilder(1 << 16);
            sb.Append("{\"id\":").Append(id).Append(",\"ms\":").Append(sw.ElapsedMilliseconds);
            sb.Append(",\"angle\":").Append(res.TextAngle.HasValue ? Num(res.TextAngle.Value) : "null");
            sb.Append(",\"lines\":[");
            bool firstLine = true;
            foreach (var line in res.Lines)
            {
                if (!firstLine) sb.Append(',');
                firstLine = false;
                sb.Append('[');
                bool firstWord = true;
                foreach (var word in line.Words)
                {
                    if (!firstWord) sb.Append(',');
                    firstWord = false;
                    var b = word.BoundingRect;
                    sb.Append('[').Append(Str(word.Text)).Append(',').Append(Num(b.X)).Append(',').Append(Num(b.Y))
                      .Append(',').Append(Num(b.Width)).Append(',').Append(Num(b.Height)).Append(']');
                }
                sb.Append(']');
            }
            sb.Append("]}");
            Emit(sb.ToString());
        }
        catch (Exception ex)
        {
            var e = ex is AggregateException && ex.InnerException != null ? ex.InnerException : ex;
            Emit("{\"id\":" + id + ",\"error\":" + Str(e.Message) + "}");
        }
    }

    // Espera uma operação assíncrona do Windows (sem as extensões .AsTask, que exigem o SDK do Windows)
    static T Wait<T>(IAsyncOperation<T> op)
    {
        using (var done = new ManualResetEventSlim(false))
        {
            op.Completed = (o, st) => done.Set();
            done.Wait();
        }
        if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode.Message);
        if (op.Status != AsyncStatus.Completed) throw new Exception("OCR interrompido");
        return op.GetResults();
    }

    static string Num(double v)
    {
        return Math.Round(v, 1).ToString(CultureInfo.InvariantCulture);
    }

    static string Str(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static void Emit(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        lock (outLock)
        {
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }
}
