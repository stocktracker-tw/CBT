# 把 Mindrise 包成 iPhone / iPad App（真・SF Symbols ＋ 系統 Liquid Glass）

網頁版的玻璃分頁列是**自己畫的**——包含那四個 icon。原因是 SF Symbols 的授權
只允許用在 **Apple 平台 App 的 UI**，不能嵌進網頁，所以網頁端最多只能照它的
視覺語言重畫。

要真正的原生符號、系統級 Liquid Glass、以及跟著捲動 morph 的行為，
分頁列必須搬到原生層。這份文件說明怎麼做。

用 Swift Playgrounds（iPad 或 Mac 都可以）開一個 App 專案，把 `ContentView.swift`
換成下面的內容即可，不需要 Xcode、不需要開發者帳號就能裝到自己的裝置上。

---

## 和 Stock Tracker 的差別（重要）

Stock Tracker 是多頁網站，所以那邊可以用 `TabView` 包**四個各自獨立的 WebView**。

Mindrise 不行。它是單頁 App，四個分頁是同一份文件裡的 `show()` 切換，資料
全都存在同一個 `localStorage`。如果開四個 WebView，等於同一個 App 開了四份，
在「工具」寫的思緒紀錄不會出現在「紀錄」分頁裡。

所以這裡的作法是：**一個共用的 WKWebView**，原生分頁列只負責呼叫網頁的
`__mindrise.show()`。狀態只有一份，切換是純 DOM 切換，瞬間完成。

---

## 網頁端的配合（已內建）

網址帶 `?native=1` 時，網頁會：

- 加上 `html.nativeshell`，把自己那條玻璃分頁列 `display:none`
- 把 `#app` 的底部留白從 110px 收成 24px（原生 bar 會佔那塊）
- 暴露 `window.__mindrise.show(view)` 給原生呼叫
- 每次換頁時往 `webkit.messageHandlers.mindrise` 回報目前分頁

旗標記在 `sessionStorage`，重新整理也維持。腳本放在 `</head>` 之前，
所以樣式在 bar 畫出來之前就生效，**不會閃一下**。
一般用 Safari 開的訪客沒有這個參數，完全不受影響。

---

## ContentView.swift

```swift
import SwiftUI
import WebKit

enum Tab: String, CaseIterable, Identifiable {
    case today, tools, history, learn
    var id: String { rawValue }

    var title: String {
        switch self {
        case .today:   "今日"
        case .tools:   "工具"
        case .history: "紀錄"
        case .learn:   "學習"
        }
    }

    /// 真・SF Symbols（在 App 內合法可用），對應網頁版重畫的那四個
    var symbol: String {
        switch self {
        case .today:   "sun.max"
        case .tools:   "lifepreserver"
        case .history: "chart.xyaxis.line"
        case .learn:   "book"
        }
    }
}

/// 單一共用的 WKWebView。Mindrise 的資料存在 localStorage，
/// 四個分頁必須共用同一個 WebView，否則會變成四份對不起來的狀態。
@MainActor
final class WebStore: NSObject, ObservableObject, WKScriptMessageHandler {
    @Published var tab: Tab = .today
    let webView: WKWebView

    /// 網頁目前實際在哪一頁。用它擋掉「原生←→網頁」互相打回去的無窮迴圈，
    /// 也避免重複呼叫 show() 把捲動位置重置掉。
    private var webSide = "today"

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController = WKUserContentController()
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()

        cfg.userContentController.add(self, name: "mindrise")   // 網頁 → 原生

        webView.scrollView.contentInsetAdjustmentBehavior = .always
        // 讓網頁自己的深色底透出來，不要蓋一層白
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear

        let url = URL(string: "https://stocktracker-tw.github.io/CBT/?native=1")!
        webView.load(URLRequest(url: url))
    }

    /// 原生 → 網頁
    func select(_ t: Tab) {
        guard t.rawValue != webSide else { return }
        webSide = t.rawValue
        webView.evaluateJavaScript("window.__mindrise && __mindrise.show('\(t.rawValue)')")
    }

    /// 網頁 → 原生：頁內自己跳頁時（例如工具頁的按鈕導到「學習」），
    /// 把分頁列的選取狀態同步過去，兩邊才不會各說各話。
    func userContentController(_ ucc: WKUserContentController,
                              didReceive msg: WKScriptMessage) {
        guard let body = msg.body as? [String: Any],
              let v = body["view"] as? String,
              let t = Tab(rawValue: v) else { return }
        webSide = v
        if tab != t { tab = t }     // select() 會被 webSide 擋下，不會打回去
    }
}

struct ContentView: View {
    @StateObject private var store = WebStore()

    var body: some View {
        ZStack {
            WebHost(webView: store.webView)
                // 只讓上緣穿到狀態列底下——網頁自己的固定標題列已經用
                // env(safe-area-inset-top) 處理過瀏海。下緣保留安全區，
                // 內容才不會被原生分頁列蓋住。
                .ignoresSafeArea(edges: .top)

            TabView(selection: $store.tab) {
                ForEach(Tab.allCases) { t in
                    Color.clear
                        .tabItem { Label(t.title, systemImage: t.symbol) }
                        .tag(t)
                }
            }
            // iOS 26 的 TabView 本身就是 Liquid Glass，不用自己套 .glassEffect()
        }
        .onChange(of: store.tab) { _, new in store.select(new) }
        .preferredColorScheme(.dark)   // Mindrise 是深色主題
    }
}

struct WebHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ v: WKWebView, context: Context) {}
}
```

### 兩個要在裝置上確認的地方

1. **網址**：上面用的是 GitHub Pages 的網址，改成你實際部署的那個。
2. **TabView 的內容底色**：這裡把四個分頁的內容都設成 `Color.clear`，
   讓底下 ZStack 的 WebView 透出來。如果實機上看到分頁列後面是一片系統底色
   而不是 Mindrise 的深色，就改用下面的備案。

---

## 備案：不用 TabView，自己排一條原生玻璃列

如果 `TabView` 的透明處理不聽話，可以直接用 iOS 26 的 `.glassEffect()`
自己排一條。符號一樣是真的 SF Symbols，玻璃一樣是系統級的：

```swift
struct GlassTabBar: View {
    @Binding var tab: Tab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases) { t in
                Button {
                    withAnimation(.snappy) { tab = t }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: t.symbol)
                            .font(.system(size: 19, weight: .regular))
                        Text(t.title).font(.system(size: 11, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .foregroundStyle(tab == t ? Color.accentColor : .secondary)
            }
        }
        .padding(6)
        .glassEffect(.regular, in: .capsule)   // 系統 Liquid Glass
        .padding(.horizontal, 16)
    }
}
```

放在 `ZStack(alignment: .bottom)` 裡疊在 WebView 上面即可：

```swift
ZStack(alignment: .bottom) {
    WebHost(webView: store.webView).ignoresSafeArea(edges: .top)
    GlassTabBar(tab: $store.tab).padding(.bottom, 6)
}
.onChange(of: store.tab) { _, new in store.select(new) }
```

---

## 其他

- App 圖示／名稱在 Swift Playgrounds 的專案設定裡改，圖示可用 repo 的 `icon-180.png`。
- 想離線可用的話，把 `index.html` 拉進專案當資源，
  用 `webView.loadFileURL(_:allowingReadAccessTo:)` 載入本地檔，
  網址後面一樣接 `?native=1`。
