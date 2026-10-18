mod connection;

use connection::{
    ConnectionIssue, ConnectionState, LaunchMode, ParsedArgs, choose_mode, parse_args,
};
use gpui::{
    App, Application, Bounds, Context, IntoElement, Render, Window, WindowBounds, WindowOptions,
    div, prelude::*, px, rgb, size,
};
use tokio::sync::oneshot;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Home,
    Worktrees,
    Review,
    Automations,
    Settings,
}

impl Page {
    const ALL: [Self; 5] = [
        Self::Home,
        Self::Worktrees,
        Self::Review,
        Self::Automations,
        Self::Settings,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Worktrees => "Worktrees",
            Self::Review => "Review",
            Self::Automations => "Automations",
            Self::Settings => "Settings",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Home => "Choose a project to start working.",
            Self::Worktrees => "Worktrees will appear here when a box is connected.",
            Self::Review => "Pull requests ready for review will appear here.",
            Self::Automations => "Scheduled work will appear here.",
            Self::Settings => "Your Shipyard preferences will appear here.",
        }
    }
}

#[derive(Clone, Copy)]
enum Appearance {
    Dark,
    Light,
}

impl Appearance {
    fn toggle(&mut self) {
        *self = match self {
            Self::Dark => Self::Light,
            Self::Light => Self::Dark,
        };
    }

    fn label(self) -> &'static str {
        match self {
            Self::Dark => "Light appearance",
            Self::Light => "Dark appearance",
        }
    }

    fn colors(self) -> Colors {
        match self {
            Self::Dark => Colors {
                background: 0x1d1e22,
                foreground: 0xe3e4e8,
                sidebar: 0x18191c,
                sidebar_foreground: 0xa9abb3,
                muted: 0x25262b,
                muted_foreground: 0x91939c,
                border: 0x2c2d33,
                accent: 0x2a2b31,
                destructive: 0xf0564a,
            },
            Self::Light => Colors {
                background: 0xffffff,
                foreground: 0x26272b,
                sidebar: 0xf1f1f3,
                sidebar_foreground: 0x5d5f67,
                muted: 0xf2f2f4,
                muted_foreground: 0x686a73,
                border: 0xe6e6ea,
                accent: 0xececef,
                destructive: 0xd93a2e,
            },
        }
    }
}

// Values mirror the built-in Shipyard Light and Dark palettes in app/src/themes/builtin.ts.
struct Colors {
    background: u32,
    foreground: u32,
    sidebar: u32,
    sidebar_foreground: u32,
    muted: u32,
    muted_foreground: u32,
    border: u32,
    accent: u32,
    destructive: u32,
}

struct Shell {
    page: Page,
    appearance: Appearance,
    mode: LaunchMode,
    connection: ConnectionState,
}

impl Shell {
    fn new(appearance: Appearance, mode: LaunchMode, cx: &mut Context<Self>) -> Self {
        let mut shell = Self {
            page: Page::Home,
            appearance,
            mode,
            connection: ConnectionState::Idle,
        };
        if matches!(shell.mode, LaunchMode::Fixture) {
            shell.connection = ConnectionState::Fixture;
        } else {
            shell.refresh_status(cx);
        }
        shell
    }

    fn refresh_status(&mut self, cx: &mut Context<Self>) {
        let LaunchMode::Live(client) = &self.mode else {
            return;
        };
        if matches!(self.connection, ConnectionState::Loading) {
            return;
        }
        self.connection = ConnectionState::Loading;
        cx.notify();
        let client = client.clone();
        let (sender, receiver) = oneshot::channel();
        std::thread::spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| ConnectionIssue::Runtime)
                .and_then(|runtime| runtime.block_on(client.status()).map_err(Into::into));
            let _ = sender.send(result);
        });
        cx.spawn(
            async move |this: gpui::WeakEntity<Shell>, cx: &mut gpui::AsyncApp| {
                let result = receiver.await.unwrap_or(Err(ConnectionIssue::Runtime));
                let _ = this.update(cx, |shell, cx| {
                    shell.connection = match result {
                        Ok(status) => status.into(),
                        Err(issue) => ConnectionState::Error(issue),
                    };
                    cx.notify();
                });
            },
        )
        .detach();
    }

    fn connection_label(&self) -> String {
        match &self.connection {
            ConnectionState::Fixture => "Fixture mode · No box connected".to_owned(),
            ConnectionState::Idle | ConnectionState::Loading => {
                "Connecting to laptop agent…".to_owned()
            }
            ConnectionState::Connected(boxes) => match boxes.len() {
                0 => "Connected · No boxes".to_owned(),
                1 => "Connected · 1 box".to_owned(),
                count => format!("Connected · {count} boxes"),
            },
            ConnectionState::Error(_) => "Connection error · Select Refresh to retry".to_owned(),
        }
    }

    fn connection_panel(&self, colors: &Colors) -> gpui::Div {
        let panel = div().flex().flex_col().items_center().gap_3();
        match &self.connection {
            ConnectionState::Fixture => panel.child(
                div()
                    .text_sm()
                    .text_color(rgb(colors.muted_foreground))
                    .child("Fixture mode is offline."),
            ),
            ConnectionState::Idle | ConnectionState::Loading => panel.child(
                div()
                    .text_sm()
                    .text_color(rgb(colors.muted_foreground))
                    .child("Reading box status…"),
            ),
            ConnectionState::Connected(boxes) => {
                if boxes.is_empty() {
                    panel.child(
                        div()
                            .text_sm()
                            .text_color(rgb(colors.muted_foreground))
                            .child("Connected to the laptop agent. No boxes are configured."),
                    )
                } else {
                    panel.children(boxes.iter().map(|box_status| {
                        div()
                            .w(px(360.))
                            .p_3()
                            .flex()
                            .justify_between()
                            .rounded_md()
                            .bg(rgb(colors.muted))
                            .text_sm()
                            .child(box_status.name.clone())
                            .child(box_status.state.clone())
                    }))
                }
            }
            ConnectionState::Error(issue) => panel
                .child(
                    div()
                        .text_lg()
                        .text_color(rgb(colors.destructive))
                        .child(issue.title()),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(colors.muted_foreground))
                        .child(issue.message()),
                ),
        }
    }

    fn nav_row(
        &self,
        page: Page,
        colors: &Colors,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let selected = self.page == page;
        div()
            .id(page.label())
            .h(px(34.))
            .w_full()
            .px_3()
            .flex()
            .items_center()
            .rounded_md()
            .text_sm()
            .text_color(rgb(if selected {
                colors.foreground
            } else {
                colors.sidebar_foreground
            }))
            .when(selected, |row| row.bg(rgb(colors.accent)))
            .hover(|row| row.bg(rgb(colors.accent)))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.page = page;
                cx.notify();
            }))
            .child(page.label())
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = self.appearance.colors();
        let sidebar = div()
            .w(px(260.))
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(colors.sidebar))
            .border_r_1()
            .border_color(rgb(colors.border))
            .child(div().h(px(40.)))
            .child(
                div()
                    .px_3()
                    .pb_4()
                    .text_base()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(colors.foreground))
                    .child("Shipyard"),
            )
            .child(
                div()
                    .px_3()
                    .text_xs()
                    .text_color(rgb(colors.muted_foreground))
                    .child("WORKSPACE"),
            )
            .child(
                div()
                    .px_3()
                    .pt_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(Page::ALL.map(|page| self.nav_row(page, &colors, cx))),
            )
            .child(div().flex_1())
            .child(
                div()
                    .mx_3()
                    .mb_3()
                    .p_3()
                    .rounded_md()
                    .bg(rgb(colors.muted))
                    .text_xs()
                    .text_color(rgb(colors.muted_foreground))
                    .child(self.connection_label()),
            );

        let refresh = div()
            .id("refresh-status")
            .px_3()
            .h(px(32.))
            .flex()
            .items_center()
            .rounded_md()
            .text_xs()
            .text_color(rgb(colors.sidebar_foreground))
            .hover(|button| button.bg(rgb(colors.accent)))
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, cx| this.refresh_status(cx)))
            .child("Refresh");
        let appearance = div()
            .id("appearance")
            .px_3()
            .h(px(32.))
            .flex()
            .items_center()
            .rounded_md()
            .text_xs()
            .text_color(rgb(colors.sidebar_foreground))
            .hover(|button| button.bg(rgb(colors.accent)))
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, cx| {
                this.appearance.toggle();
                cx.notify();
            }))
            .child(self.appearance.label());
        let controls = div()
            .flex()
            .items_center()
            .gap_2()
            .when(matches!(self.mode, LaunchMode::Live(_)), |controls| {
                controls.child(refresh)
            })
            .child(appearance);

        let main = div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(colors.background))
            .text_color(rgb(colors.foreground))
            .child(
                div()
                    .h(px(40.))
                    .w_full()
                    .px_4()
                    .flex()
                    .items_center()
                    .justify_between()
                    .bg(rgb(colors.sidebar))
                    .border_b_1()
                    .border_color(rgb(colors.border))
                    .child(self.page.label())
                    .child(controls),
            )
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .child(
                        div()
                            .text_2xl()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(self.page.label()),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(colors.muted_foreground))
                            .child(self.page.description()),
                    )
                    .when(
                        matches!(self.page, Page::Home | Page::Worktrees)
                            || matches!(self.connection, ConnectionState::Error(_)),
                        |content| content.child(self.connection_panel(&colors)),
                    ),
            )
            .child(
                div()
                    .h(px(26.))
                    .w_full()
                    .px_3()
                    .flex()
                    .items_center()
                    .border_t_1()
                    .border_color(rgb(colors.border))
                    .text_xs()
                    .text_color(rgb(colors.muted_foreground))
                    .child(self.connection_label()),
            );

        div()
            .size_full()
            .flex()
            .bg(rgb(colors.background))
            .child(sidebar)
            .child(main)
    }
}

fn main() {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(ParsedArgs::Help) => {
            println!(
                "Shipyard GPUI shell\n\nUsage: shipyard-app [--fixture] [--light]\n       shipyard-app --endpoint http://127.0.0.1:PORT [--light]\n\nLive mode requires SHIPYARD_API_TOKEN in the environment. Fixture mode is offline."
            );
            return;
        }
        Ok(ParsedArgs::Launch(options)) => options,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let appearance = if options.appearance_light {
        Appearance::Light
    } else {
        Appearance::Dark
    };
    let token = options
        .endpoint
        .as_ref()
        .and_then(|_| std::env::var("SHIPYARD_API_TOKEN").ok());
    let mode = match choose_mode(&options, token.as_deref()) {
        Ok(mode) => mode,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1100.), px(720.)), cx);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |window, cx| {
                window.set_window_title("Shipyard");
                cx.new(|cx| Shell::new(appearance, mode, cx))
            },
        )
        .expect("open Shipyard window");
        cx.activate(true);
    });
}
