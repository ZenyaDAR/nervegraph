mod lexer;

pub fn parse(s: &str) -> usize {
    lexer::tokens(s)
}
