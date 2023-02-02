use crate::*;

#[derive(Copy, Clone, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub enum Symbol {
    X,
    O,
}

#[derive(Copy, Clone, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub enum State {
    Unaccepted,
    Turn { index: u8 },
    Draw,
    Over { winner: Pubkey },
}
impl Default for State {
    fn default() -> Self {
        Self::Unaccepted
    }
}

#[account]
#[derive(Default)]
pub struct Game {
    pub players: [Pubkey; 2],
    pub board: [[Option<Symbol>; 3]; 3],
    pub state: State,
    pub stake_mint: Pubkey,
    pub stake_amount: u64,
}

impl Game {
    pub fn play(&mut self, player: Pubkey, row: u8, col: u8) -> Result<()> {
        let current_player;
        if let State::Turn { index } = self.state {
            require_keys_eq!(
                player,
                self.players[index as usize],
                GameError::NotAuthorized
            );
            current_player = index;
        } else {
            if let State::Unaccepted = self.state {
                return err!(GameError::UnacceptedGame);
            }
            return err!(GameError::GameAlreadyCompleted);
        }
        require!(row < 3 && col < 3, GameError::InvalidTile);
        if let Some(_) = self.board[row as usize][col as usize] {
            return err!(GameError::TileAlreadyTaken);
        }
        self.board[row as usize][col as usize] = if current_player == 0 {
            Some(Symbol::X)
        } else {
            Some(Symbol::O)
        };
        self.update_state(current_player);
        Ok(())
    }
    fn update_state(&mut self, current_player: u8) {
        for i in 0..3 {
            if self.got_winner(self.board[i][0], self.board[i][1], self.board[i][2])
                || self.got_winner(self.board[0][i], self.board[1][i], self.board[2][i])
            {
                return;
            }
        }
        if self.got_winner(self.board[0][0], self.board[1][1], self.board[2][2])
            || self.got_winner(self.board[0][2], self.board[1][1], self.board[2][0])
        {
            return;
        }
        for row in self.board.iter() {
            for tile in row.iter() {
                if let None = tile {
                    self.state = State::Turn {
                        index: (current_player + 1) % 2,
                    };
                    return;
                }
            }
        }
        self.state = State::Draw;
    }
    fn got_winner(
        &mut self,
        first: Option<Symbol>,
        second: Option<Symbol>,
        third: Option<Symbol>,
    ) -> bool {
        if let (Some(a), Some(b), Some(c)) = (first, second, third) {
            if a == b && a == c {
                let winner = if a == Symbol::X {
                    self.players[0]
                } else {
                    self.players[1]
                };
                self.state = State::Over { winner };
                return true;
            }
        }
        false
    }
}

#[error_code]
pub enum GameError {
    #[msg("stake amount for a game can not be zero")]
    ZeroStakeAmount,
    #[msg("user not authorised to perform the action")]
    NotAuthorized,
    #[msg("game has not been accepted by player2")]
    UnacceptedGame,
    #[msg("can not accept a game more than once")]
    GameAlreadyAccepted,
    #[msg("game has already been completed")]
    GameAlreadyCompleted,
    #[msg("moves left in the game")]
    GameNotCompleted,
    #[msg("tile position is out of bounds")]
    InvalidTile,
    #[msg("tile has already been marked")]
    TileAlreadyTaken,
}
