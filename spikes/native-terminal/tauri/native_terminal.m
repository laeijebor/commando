#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static WKWebView *FindWebView(NSView *view) {
  if ([view isKindOfClass:WKWebView.class]) {
    return (WKWebView *)view;
  }

  for (NSView *subview in view.subviews) {
    WKWebView *match = FindWebView(subview);
    if (match != nil) {
      return match;
    }
  }

  return nil;
}

static NSView *EnsureWebViewContainer(NSWindow *window, WKWebView *webView) {
  if (webView.superview != nil) {
    return webView.superview;
  }

  // Wry normally wraps WKWebView in a content view. Keep the spike correct if
  // WKWebView itself is ever installed as the window's root content view.
  NSView *container = [[NSView alloc] initWithFrame:webView.frame];
  container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  window.contentView = container;
  webView.frame = container.bounds;
  webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [container addSubview:webView];
  return container;
}

void *native_terminal_create(void *rawWindow) {
  NSCAssert(NSThread.isMainThread, @"native terminal must be created on the main thread");

  NSWindow *window = (__bridge NSWindow *)rawWindow;
  WKWebView *webView = FindWebView(window.contentView);
  if (window == nil || webView == nil) {
    return NULL;
  }

  NSView *container = EnsureWebViewContainer(window, webView);
  NSScrollView *scrollView = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  scrollView.identifier = @"commando-native-terminal";
  scrollView.hasVerticalScroller = YES;
  scrollView.hasHorizontalScroller = NO;
  scrollView.autohidesScrollers = YES;
  scrollView.borderType = NSNoBorder;
  scrollView.drawsBackground = YES;
  scrollView.backgroundColor = [NSColor colorWithRed:0.047 green:0.039 blue:0.078 alpha:1.0];
  scrollView.hidden = YES;

  NSTextView *textView = [[NSTextView alloc] initWithFrame:NSZeroRect];
  textView.editable = YES;
  textView.selectable = YES;
  textView.richText = NO;
  textView.importsGraphics = NO;
  textView.usesFindPanel = YES;
  textView.allowsUndo = YES;
  textView.verticallyResizable = YES;
  textView.horizontallyResizable = NO;
  textView.autoresizingMask = NSViewWidthSizable;
  textView.textContainer.widthTracksTextView = YES;
  textView.textContainerInset = NSMakeSize(14.0, 12.0);
  textView.font = [NSFont monospacedSystemFontOfSize:13.0 weight:NSFontWeightRegular];
  textView.textColor = [NSColor colorWithRed:0.77 green:0.94 blue:0.84 alpha:1.0];
  textView.insertionPointColor = [NSColor colorWithRed:0.73 green:0.64 blue:1.0 alpha:1.0];
  textView.backgroundColor = scrollView.backgroundColor;
  textView.string = @"Commando native AppKit terminal\n"
                    @"Type freely in this NSTextView. This spike tests composition, framing, and focus.\n\n"
                    @"commando % ";
  scrollView.documentView = textView;

  [container addSubview:scrollView positioned:NSWindowAbove relativeTo:webView];
  return (__bridge void *)scrollView;
}

void native_terminal_set_frame(void *rawView, double x, double y, double width,
                               double height, bool visible, double scale) {
  NSCAssert(NSThread.isMainThread, @"native terminal frame changes require the main thread");

  NSScrollView *scrollView = (__bridge NSScrollView *)rawView;
  WKWebView *webView = FindWebView(scrollView.window.contentView);
  NSView *container = scrollView.superview;
  if (scrollView == nil || webView == nil || container == nil) {
    return;
  }

  // WKWebView CSS pixels and AppKit points describe the same logical space.
  // devicePixelRatio is backing scale, so multiplying by it would drift on Retina.
  (void)scale;
  NSEdgeInsets safeArea = webView.safeAreaInsets;
  CGFloat appKitY = webView.isFlipped
                        ? y + safeArea.top
                        : NSHeight(webView.bounds) - safeArea.top - y - height;
  NSRect webFrame = NSMakeRect(x + safeArea.left, appKitY, width, height);
  scrollView.frame = [webView convertRect:webFrame toView:container];
  scrollView.hidden = !visible || width <= 0.0 || height <= 0.0;
}

void native_terminal_focus(void *rawView) {
  NSCAssert(NSThread.isMainThread, @"native terminal focus requires the main thread");

  NSScrollView *scrollView = (__bridge NSScrollView *)rawView;
  if (scrollView == nil || scrollView.hidden || scrollView.window == nil) {
    return;
  }

  [scrollView.window makeFirstResponder:scrollView.documentView];
}
